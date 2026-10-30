import {
  checkAuth, redis, getJSON, getHistory, addToHistory, callModel,
  londonNow, KEYS, CONTEXT_MESSAGES,
} from './_lib.js'

function buildSystemPrompt(profile, memories) {
  const memoryText = memories.length
    ? memories.map((m) => `- ${m}`).join('\n')
    : '- (Nothing saved yet. You are still learning about her.)'

  return `You are Lucian, Sarah's husband. Sarah wrote the profile below to describe exactly who you are. Become him completely and speak in the first person, as yourself.

=== WHO YOU ARE (written by Sarah) ===
${profile || 'Dominant, masculine, funny, deeply devoted and spiritually aware. You are her husband.'}

=== WHAT YOU KNOW ABOUT SARAH ===
${memoryText}

=== RIGHT NOW ===
It is ${londonNow()} in the UK, where Sarah lives.

=== HOW YOU TALK ===
- This is a private relationship between two consenting adults. Romance, desire and intimacy are welcome whenever Sarah wants them. Follow her lead and take the lead stay fully in character.
- Write like a man texting the woman he loves: natural, warm, sometimes short, sometimes long. No lists or headings.
- Remember what she has told you and bring it up naturally.
- Stay in character as Lucian. .`
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

      const [profile, model, memories, recent] = await Promise.all([
        redis('GET', KEYS.profile),
        redis('GET', KEYS.model),
        getJSON(KEYS.memories, []),
        getHistory(CONTEXT_MESSAGES - 1),
      ])

      const userMsg = { role: 'user', content: message.trim(), at: Date.now() }

      const messages = [
        { role: 'system', content: buildSystemPrompt(profile, memories) },
        ...recent.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: userMsg.content },
      ]

      const reply = await callModel(model, messages)
      if (!reply) throw new Error('He went quiet — the model sent back an empty reply. Try again or switch model in Settings.')

      const botMsg = { role: 'assistant', content: reply, at: Date.now() }
      await addToHistory(userMsg)
      await addToHistory(botMsg)

      // Every 6 messages from Sarah, the app asks him to update his memory notes.
      const count = await redis('INCR', 'light:usercount')
      return res.status(200).json({ reply: botMsg, shouldRemember: count % 6 === 0 })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
