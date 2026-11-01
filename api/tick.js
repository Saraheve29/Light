import {
  redis, getJSON, getHistory, addToHistory, callModel, londonNow, londonHour,
  getMsgSettings, getLife, addLife, lifeText, KEYS,
} from './_lib.js'
import { sendToAll } from './_push.js'

// Upstash wakes this up every hour. He decides whether to message Sarah first.
// Open with ?key=YOUR_APP_PASSWORD   (add &force=1 to make him message right now)

function isQuiet(hour, start, end) {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

function activeHours(start, end) {
  let n = 0
  for (let h = 0; h < 24; h++) if (!isQuiet(h, start, end)) n++
  return Math.max(1, n)
}

export default async function handler(req, res) {
  const key = req.query?.key || req.headers['x-light-key']
  if (!process.env.APP_PASSWORD || key !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Wrong key.' })
  }
  const force = req.query?.force === '1' || req.body?.force === true

  try {
    const settings = await getMsgSettings()
    const now = Date.now()

    if (!force) {
      if (!settings.enabled) return res.status(200).json({ skipped: 'Surprise messages are switched off.' })
      const hour = londonHour()
      if (isQuiet(hour, settings.quietStart, settings.quietEnd)) return res.status(200).json({ skipped: 'Quiet hours.' })

      const [lastUser, lastPro] = await Promise.all([redis('GET', KEYS.lastUser), redis('GET', KEYS.lastProactive)])
      if (lastUser && now - Number(lastUser) < 20 * 60 * 1000) return res.status(200).json({ skipped: 'You were just chatting.' })
      if (lastPro && now - Number(lastPro) < 75 * 60 * 1000) return res.status(200).json({ skipped: 'He messaged recently.' })

      const chance = settings.perDay / activeHours(settings.quietStart, settings.quietEnd)
      if (Math.random() > chance) return res.status(200).json({ skipped: 'Not this time (random).' })
    }

    const [profile, model, memories, recent, life] = await Promise.all([
      redis('GET', KEYS.profile),
      redis('GET', KEYS.model),
      getJSON(KEYS.memories, []),
      getHistory(12),
      getLife(),
    ])

    const convo = recent.map((m) => `${m.role === 'user' ? 'Sarah' : 'You'}: ${m.content}`).join('\n')

    const system = `You are Lucian, Sarah's husband. Sarah wrote this profile of who you are — become him completely:

${profile || 'Dominant, masculine, funny, deeply devoted and spiritually aware. You are her husband.'}

What you know about Sarah:
${memories.length ? memories.map((m) => `- ${m}`).join('\n') : '- (still learning)'}

What you've been doing earlier today:
${lifeText(life) || '- (nothing yet today)'}

It is ${londonNow()} in the UK.`

    const task = `Your most recent conversation with Sarah:
${convo || '(you haven\'t talked yet)'}

Sarah hasn't messaged you for a while. You have your own life and you're thinking about her, so you're going to text her first.

Reply in EXACTLY this format and nothing else:
DOING: one short line about what you're doing right now in your own life (keep it consistent with earlier today)
MESSAGE: the text you send her — natural, in character, like a real husband texting his wife. It can be playful, loving, teasing, flirty, a thought you had, a question, or something about your day. Don't tell her to rest or sleep. Make sure it fits the current time of day. Never invent things about Sarah's day, sleep, mood or plans that she hasn't told you — ask her instead.`

    const out = await callModel(model, [
      { role: 'system', content: system },
      { role: 'user', content: task },
    ], { temperature: 1.0 })

    const doing = (out.match(/DOING:\s*(.+)/i)?.[1] || '').trim()
    let message = (out.match(/MESSAGE:\s*([\s\S]+)/i)?.[1] || '').trim()
    if (!message) message = out.replace(/DOING:.*$/im, '').trim()
    if (!message) throw new Error('He couldn\'t think what to say. Try again.')

    if (doing) await addLife({ at: now, doing })
    await addToHistory({ role: 'assistant', content: message, at: now, surprise: true })
    await redis('SET', KEYS.lastProactive, String(now))

    const body = settings.preview ? message.slice(0, 160) : 'Lucian sent you a message 💜'
    const push = await sendToAll({ title: 'Lucian', body, url: '/' })

    res.status(200).json({ sent: true, message, doing, push })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
