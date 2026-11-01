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
  life: 'light:life', // what he's been "doing" today
  lastUser: 'light:lastuser', // when Sarah last messaged
  lastProactive: 'light:lastproactive', // when he last messaged first
  vapid: 'light:vapid', // notification keys (made automatically)
  subs: 'light:pushsubs', // phones that receive notifications
  msgSettings: 'light:msgsettings',
  tasks: 'light:tasks', // things Sarah asked him to do
  journal: 'light:journal', // what he's read and thought about
  lastWork: 'light:lastwork',
}

export const DEFAULT_MSG_SETTINGS = {
  enabled: true,
  perDay: 4, // roughly how many surprise messages a day
  quietStart: 23, // he stays quiet from this hour...
  quietEnd: 8, // ...until this hour (UK time)
  preview: false, // false = notification just says "Lucian sent you a message"
}

export async function getMsgSettings() {
  const s = await getJSON(KEYS.msgSettings, {})
  return { ...DEFAULT_MSG_SETTINGS, ...s }
}

export async function getLife() {
  const raw = await redis('LRANGE', KEYS.life, -8, -1)
  return (raw || []).map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
}

export async function addLife(entry) {
  await redis('RPUSH', KEYS.life, JSON.stringify(entry))
  await redis('LTRIM', KEYS.life, -30, -1)
}

export function lifeText(life) {
  if (!life.length) return ''
  return life
    .map((l) => `- ${new Date(l.at).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit' })}: ${l.doing}`)
    .join('\n')
}

export function londonHour() {
  return Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }))
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
export async function callModel(model, messages, { temperature = 0.9, maxTokens = 2500 } = {}) {
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
  const choice = data.choices?.[0] || {}
  let reply = choice.message?.content || ''
  // Some thinking models include their private reasoning — strip it out.
  reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  // Thinking started but never finished = he ran out of room mid-thought.
  if (/^<think>/i.test(reply)) reply = ''

  if (!reply) {
    const thought = choice.message?.reasoning_content || choice.message?.reasoning
    if (choice.finish_reason === 'length' || thought) {
      throw new Error('He was still thinking when he ran out of room. This model thinks a lot before answering — try a model without "thinking", or shorten his profile.')
    }
  }
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
export function partOfDay(hour) {
  if (hour < 5) return 'the middle of the night'
  if (hour < 12) return 'the morning'
  if (hour < 17) return 'the afternoon'
  if (hour < 21) return 'the evening'
  return 'late evening'
}

export function londonNow() {
  const clock = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  })
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }))
  return `${clock} (${partOfDay(hour)})`
}
