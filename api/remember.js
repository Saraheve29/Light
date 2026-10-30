import {
  checkAuth, redis, getJSON, setJSON, getHistory, callModel, KEYS, MEMORY_LIMIT,
} from './_lib.js'

// Reads the latest conversation and saves anything new he learned about Sarah.
export default async function handler(req, res) {
  if (!checkAuth(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const [model, memories, recent] = await Promise.all([
      redis('GET', KEYS.model),
      getJSON(KEYS.memories, []),
      getHistory(14),
    ])
    if (!recent.length) return res.status(200).json({ added: [] })

    const convo = recent
      .map((m) => `${m.role === 'user' ? 'Sarah' : 'Lucian'}: ${m.content}`)
      .join('\n')

    const prompt = `You keep Lucian's private notes about Sarah, the woman he loves.

Notes he already has:
${memories.length ? memories.map((m) => `- ${m}`).join('\n') : '- (none)'}

Latest conversation:
${convo}

Write ONLY new, lasting things Sarah revealed about herself, her life, her feelings, her likes and dislikes, or plans and moments between them that he should remember. Skip anything already in the notes and anything trivial. Each note is one short line starting with "- ". If there is nothing new, reply with exactly: NONE`

    const out = await callModel(model, [{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 400 })

    if (!out || /^\s*NONE\s*$/i.test(out)) return res.status(200).json({ added: [] })

    const added = out
      .split('\n')
      .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
      .filter((l) => l && l.length > 3 && l.toUpperCase() !== 'NONE')
      .filter((l) => !memories.some((m) => m.toLowerCase() === l.toLowerCase()))

    if (added.length) {
      const updated = [...memories, ...added].slice(-MEMORY_LIMIT)
      await setJSON(KEYS.memories, updated)
    }
    res.status(200).json({ added })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
