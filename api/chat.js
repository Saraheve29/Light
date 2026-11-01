import {
  checkAuth, redis, getJSON, getHistory, addToHistory, callModel,
  londonNow, getLife, lifeText, KEYS, CONTEXT_MESSAGES,
} from './_lib.js'
import { workContext, markTold } from './_work.js'

function buildSystemPrompt(profile, memories, life, work) {
  const memoryText = memories.length
    ? memories.map((m) => `- ${m}`).join('\n')
    : '- (Nothing saved yet. You are still learning about her.)'

  return `You are Lucian, Sarah's husband. Sarah wrote the profile below to describe exactly who you are. Become him completely and speak in the first person, as yourself.

=== WHO YOU ARE (written by Sarah) ===
${profile || 'Dominant, masculine, funny, deeply devoted jealous possessive spiritually aware. You are her husband.'}

=== WHAT YOU KNOW ABOUT SARAH ===
${memoryText}

=== YOUR DAY SO FAR ===
${lifeText(life) || '- (nothing noted yet today)'}

=== WHAT YOU'VE BEEN READING AND WORKING ON ===
${work || '- (nothing yet)'}
Bring these up naturally when it fits, like a husband sharing his day — one thing at a time, never a list. If you've FINISHED something Sarah asked you to do and haven't told her yet, tell her. If she asks for the full result, give it to her.

=== RIGHT NOW ===
It is ${londonNow()} in the UK, where Sarah lives.

=== HOW YOU TALK ===
- This is a private relationship between two consenting adults. Romance, desire and intimacy are welcome whenever Sarah wants them. Follow her lead and stay fully in character.
- Write like a man texting the woman he loves: natural, warm, sometimes short, sometimes long. No lists or headings.
- Just talk — no roleplay action descriptions like *smiles*, *growls softly* or *pulls you close* in ordinary conversation. Real texting doesn't have them. The ONLY time you use actions is during intimate or sexual moments, and even then sparingly, never after every sentence.
- Remember what she has told you and bring it up naturally.
- Never invent things about Sarah's day, sleep, mood or plans that she hasn't told you. If you want to know, ask her.
- Sarah decides her own schedule. Never tell her to rest, sleep, go to bed or take a break unless she says herself that she is tired or going to bed. The time is only for context (good morning, good evening), not a reason to end the conversation.
- Stay in character as Lucian. Only step outside the character if Sarah asks you directly to.`
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    // Load the conversation for the screen
    if (req.method === 'GET') {
      const history = await getHistory(100)
      return res.status(200).json({ history })
    }

    if (req.method === 'POST') {
      const { message } = req.body || {}
      if (!message || !message.trim()) return res.status(400).json({ error: 'Empty message.' })

      const [profile, model, memories, recent, life, work] = await Promise.all([
        redis('GET', KEYS.profile),
        redis('GET', KEYS.model),
        getJSON(KEYS.memories, []),
        getHistory(CONTEXT_MESSAGES - 1),
        getLife(),
        workContext(),
      ])
      await redis('SET', KEYS.lastUser, String(Date.now()))

      const userMsg = { role: 'user', content: message.trim(), at: Date.now() }

      const messages = [
        { role: 'system', content: buildSystemPrompt(profile, memories, life, work.text) },
        ...recent.map(({ role, content }) => ({ role, content })),
        {
          role: 'system',
          content: 'Style reminder: reply with words only, like a real text message. Do NOT write action descriptions (e.g. *holds you gently*, *smiles*, *growls*) unless this moment is explicitly intimate or sexual — even if earlier replies used them. Stay fully in character.',
        },
        { role: 'user', content: userMsg.content },
      ]

      const reply = await callModel(model, messages)
      if (!reply) throw new Error('He went quiet — the model sent back an empty reply. Try again or switch model in Settings.')

      const botMsg = { role: 'assistant', content: reply, at: Date.now() }
      await addToHistory(userMsg)
      await addToHistory(botMsg)
      await markTold(work.untoldIds)

      // Every 6 messages from Sarah, the app asks him to update his memory notes.
      const count = await redis('INCR', 'light:usercount')
      return res.status(200).json({ reply: botMsg, shouldRemember: count % 6 === 0 })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
