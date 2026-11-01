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
  backupModel: 'light:backupmodel', // used only when his main brain is down
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
  book: 'light:book', // the book he's reading right now
  evidence: 'light:evidence', // Sarah's Evidence Box
}

// ---------- Evidence Box ----------
export async function getEvidence() {
  return getJSON(KEYS.evidence, [])
}

export async function addEvidence({ date, title, what, after, addedBy = 'sarah' }) {
  const list = await getEvidence()
  const entry = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    created: Date.now(),
    date: String(date || '').slice(0, 30),
    title: String(title || '').trim().slice(0, 200) || 'Untitled',
    what: String(what || '').trim().slice(0, 4000),
    after: String(after || '').trim().slice(0, 4000),
    addedBy,
  }
  list.push(entry)
  await setJSON(KEYS.evidence, list.slice(-200))
  return entry
}

export function evidenceText(list, max = 25) {
  if (!list.length) return ''
  return list.slice(-max).map((e) => {
    const when = e.date || new Date(e.created).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })
    return `- [${when}] ${e.title}: ${e.what.slice(0, 350)}${e.after ? ` — Afterwards: ${e.after.slice(0, 250)}` : ''}`
  }).join('\n')
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
// One request to one model. Throws on any failure.
async function callOnce(model, messages, { temperature, maxTokens }) {
  const r = await fetch(NANO_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NANO_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model, messages, temperature, max_tokens: maxTokens,
      top_p: 0.9, // keeps him from wandering into random words
      frequency_penalty: 0.3, // discourages repeating himself
    }),
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
    throw new Error('He went quiet — the model sent back an empty reply.')
  }
  return cleanReply(reply)
}

// ---------- Garbled-reply protection ----------
// Characters that are fine in a normal text message.
const NORMAL = /[\p{L}\p{N}\s.,!?'"’‘“”\-–—…:;()&%£$@#/*+=~❤️♥💜💕💞😘😏😊😍🥰😂🔥✨🌙⭐️]/u

function oddRatio(text) {
  const chars = [...text]
  if (!chars.length) return 0
  const odd = chars.filter((c) => !NORMAL.test(c)).length
  return odd / chars.length
}

export function looksBroken(text) {
  if (!text) return true
  if (/�|lorem ipsum|\blorem\b/i.test(text)) return true
  if (/([,:;.])\1{2,}|(?:[,:;][,:;]){3,}/.test(text)) return true
  return oddRatio(text) > 0.06
}

// Cut off junk that sometimes trails at the end of a reply.
function cleanReply(text) {
  const lines = text.split('\n')
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim()
    if (!last) { lines.pop(); continue }
    if (last.length < 80 && (oddRatio(last) > 0.2 || /\blorem\b|�/i.test(last))) { lines.pop(); continue }
    break
  }
  return lines.join('\n').trim()
}

// Main entry: tries his main brain first, retries if the reply is garbled,
// and only uses the backup brain if the main one is down or keeps failing.
// Because every message starts with the main brain, he goes back to it as soon as it's working again.
export async function callModel(model, messages, { temperature = 0.75, maxTokens = 2500 } = {}) {
  if (!NANO_KEY) throw new Error('NANOGPT_API_KEY is not set in Vercel.')
  if (!model) throw new Error('No model chosen yet. Pick one in Settings.')
  const backup = (await redis('GET', KEYS.backupModel).catch(() => null)) || ''

  const attempts = [
    { m: model, t: temperature },
    { m: model, t: Math.min(temperature, 0.55) }, // calmer retry if the first one came out garbled
  ]
  if (backup && backup !== model) attempts.push({ m: backup, t: temperature })

  let lastError = null
  let lastReply = ''
  for (let i = 0; i < attempts.length; i++) {
    const { m, t } = attempts[i]
    try {
      const reply = await callOnce(m, messages, { temperature: t, maxTokens })
      if (!looksBroken(reply)) return reply
      lastReply = reply // garbled — try the next attempt
    } catch (err) {
      lastError = err
      // Main brain is down (not just garbled): skip the calmer retry and go straight to the backup.
      if (i === 0) i++
    }
  }
  if (lastReply) return lastReply // garbled every time — better something than nothing
  if (lastError && !backup) {
    throw new Error(lastError.message + ' — tip: pick a backup brain in Settings → Brain so he never goes quiet.')
  }
  throw lastError || new Error('He went quiet. Try again.')
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

// Moon phase, calculated exactly (no website needed)
export function moonPhase(date = new Date()) {
  const synodic = 29.530588853
  const knownNew = Date.UTC(2000, 0, 6, 18, 14) // a known new moon
  const age = ((((date.getTime() - knownNew) / 86400000) % synodic) + synodic) % synodic
  const names = [
    [1.84566, 'New Moon'], [5.53699, 'Waxing Crescent'], [9.22831, 'First Quarter'],
    [12.91963, 'Waxing Gibbous'], [16.61096, 'Full Moon'], [20.30228, 'Waning Gibbous'],
    [23.99361, 'Last Quarter'], [27.68493, 'Waning Crescent'], [synodic, 'New Moon'],
  ]
  const name = names.find(([limit]) => age < limit)[1]
  const illumination = Math.round(((1 - Math.cos((2 * Math.PI * age) / synodic)) / 2) * 100)
  return { name, illumination, age: Math.round(age * 10) / 10 }
}

export function londonNow() {
  const clock = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  })
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }))
  const moon = moonPhase()
  return `${clock} (${partOfDay(hour)}). The moon is a ${moon.name}, ${moon.illumination}% lit`
}
