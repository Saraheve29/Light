// Shared helpers for Light's server functions.
// Files starting with "_" are not turned into API routes by Vercel.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const NANO_KEY = process.env.NANOGPT_API_KEY
const APP_PASSWORD = process.env.APP_PASSWORD

// Subscription endpoint keeps him on models your $12 plan covers.
export const NANO_CHAT_URL = 'https://nano-gpt.com/api/subscription/v1/chat/completions'
export const NANO_MODELS_URLS = [
  'https://nano-gpt.com/api/subscription/v1/models',
  'https://nano-gpt.com/api/v1/models',
]

export const KEYS = {
  profile: 'light:profile',
  model: 'light:model',
  memories: 'light:memories',
  history: 'light:history',
}

export const HISTORY_LIMIT = 300 // messages kept in storage
export const CONTEXT_MESSAGES = 30 // recent messages he reads each reply
export const MEMORY_LIMIT = 80 // memory notes kept

// ---------- Security ----------
export function checkAuth(req, res) {
  if (!APP_PASSWORD) {
    res.status(500).json({ error: 'APP_PASSWORD is not set in Vercel.' })
    return false
  }
  if (req.headers['x-light-key'] !== APP_PASSWORD) {
    res.status(401).json({ error: 'Wrong password.' })
    return false
  }
  return true
}

// ---------- Upstash Redis ----------
export async function redis(...command) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Upstash Redis is not set up in Vercel.')
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body: JSON.stringify(command),
  })
  const data = await r.json()
  if (data.error) throw new Error('Redis: ' + data.error)
  return data.result
}

export async function getJSON(key, fallback) {
  const raw = await redis('GET', key)
  if (!raw) return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

export async function setJSON(key, value) {
  return redis('SET', key, JSON.stringify(value))
}

export async function getHistory(count = CONTEXT_MESSAGES) {
  const raw = await redis('LRANGE', KEYS.history, -count, -1)
  return (raw || []).map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
}

export async function addToHistory(msg) {
  await redis('RPUSH', KEYS.history, JSON.stringify(msg))
  await redis('LTRIM', KEYS.history, -HISTORY_LIMIT, -1)
}

// ---------- NanoGPT ----------
export async function callModel(model, messages, { temperature = 0.9, maxTokens = 900 } = {}) {
  if (!NANO_KEY) throw new Error('NANOGPT_API_KEY is not set in Vercel.')
  if (!model) throw new Error('No model chosen yet. Pick one in Settings.')
  const r = await fetch(NANO_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NANO_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error('NanoGPT sent something unexpected: ' + text.slice(0, 200)) }
  if (!r.ok || data.error) {
    const msg = data.error?.message || data.error || `status ${r.status}`
    throw new Error('NanoGPT: ' + msg)
  }
  let reply = data.choices?.[0]?.message?.content || ''
  // Some thinking models include their private reasoning — strip it out.
  reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  return reply
}

export async function listModels() {
  for (const url of NANO_MODELS_URLS) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${NANO_KEY}` } })
      if (!r.ok) continue
      const data = await r.json()
      const items = data.data || data.models || []
      const ids = items.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
      if (ids.length) return ids.sort()
    } catch {
      // try the next url
    }
  }
  return []
}

// ---------- Time ----------
export function londonNow() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  })
}
