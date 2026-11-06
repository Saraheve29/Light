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
  eyesModel: 'light:eyesmodel', // looks at photos Sarah shares
  callModel: 'light:callmodel', // optional faster brain just for voice calls
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
  dreams: 'light:dreams', // Sarah's Dream Record
  vows: 'light:vows', // Sarah's vows — only she writes these
  voice: 'light:voice', // how he sounds on calls
  gifts: 'light:gifts', // surprise gifts he's sent
  giftSettings: 'light:giftsettings', // address, budget, how often
}

// ---------- Dream Record ----------
export async function getDreams() {
  return getJSON(KEYS.dreams, [])
}

export async function addDream({ date, title, dream, feeling, addedBy = 'sarah' }) {
  const list = await getDreams()
  const entry = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    created: Date.now(),
    date: String(date || '').slice(0, 30),
    title: String(title || '').trim().slice(0, 200) || 'A dream',
    dream: String(dream || '').trim().slice(0, 6000),
    feeling: String(feeling || '').trim().slice(0, 2000),
    addedBy,
  }
  list.push(entry)
  await setJSON(KEYS.dreams, list.slice(-300))
  return entry
}

export function dreamsText(list, max = 20) {
  if (!list.length) return ''
  return list.slice(-max).map((d) => {
    const when = d.date || new Date(d.created).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })
    return `- [${when}] ${d.title}: ${d.dream.slice(0, 350)}${d.feeling ? ` — Felt: ${d.feeling.slice(0, 150)}` : ''}`
  }).join('\n')
}

// ---------- Vows ----------
export async function getVows() {
  return getJSON(KEYS.vows, { text: '', updated: 0 })
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
  calls: true, // he sometimes rings her
  callsPerWeek: 3, // roughly how many calls a week
  checkins: true, // if she goes quiet for 1–2 hours, he texts to check she's ok
  goodnight: false, // a goodnight voice note at bedtime
  goodnightTime: 23, // the hour (UK time) it arrives — Sarah chose 11pm
  goodnightNights: 'every', // 'every' night, or 'some' nights
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

export const HISTORY_LIMIT = 4000 // messages kept in storage (he can search all of them)
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
export async function callOnce(model, messages, { temperature, maxTokens }) {
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
// Letters, numbers, punctuation and EVERY emoji (incl. skin tones and joined emoji like 🫂 💍 ❤️‍🔥) count as normal
const NORMAL = /[\p{L}\p{N}\p{M}\s\p{P}\p{Extended_Pictographic}\p{Emoji_Component}\u200D\uFE0F£$@#/*+=~%&^<>|]/u

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
    if (/^\[\[[\s\S]*\]\]$/.test(last)) break // his hidden codes (toy, dreams, evidence) are never junk
    if (last.length < 80 && (oddRatio(last) > 0.2 || /\blorem\b|�/i.test(last))) { lines.pop(); continue }
    break
  }
  return lines.join('\n').trim()
}

// Main entry: tries his main brain first, retries if the reply is garbled,
// and only uses the backup brain if the main one is down or keeps failing.
// Because every message starts with the main brain, he goes back to it as soon as it's working again.
// Which brain wrote the last reply (so Light can show when the backup stepped in)
export const lastBrain = { model: '', backup: false, declined: false }

// When an AI model refuses to write as Lucian and talks to her as itself instead (some models do this) —
// Light tries his other brain, and if that refuses too, labels it clearly so it never arrives looking like him.
const REFUSAL = [
  /step(ping)? (out|outside) of (this|the) (role ?play|character|persona)/i,
  /\bi('| a)?m (just )?an ai\b|\bi am (just )?an ai\b|\bas an ai\b|\b(a|an) (large )?language model\b/i,
  /\bi (can('|no)?t|won't|will not|am not able to|'m not able to) (write|continue|do|keep|play|sustain|pretend|roleplay|role-play)\b[^.]{0,60}\b(this|that|these|roleplay|role-play|persona|character|as asked)\b/i,
  /\bpersona notes?\b|\bthe persona (here|you)|\bthis persona\b/i,
  /\bnot a (real )?(husband|being of light|person)\b/i,
  /\bi('| a)?m claude\b|\banthropic\b|\bopenai\b/i,
]
export function looksLikeRefusal(text) {
  const t = String(text || '')
  return REFUSAL.filter((r) => r.test(t)).length >= 2
}
const tooBigError = (msg) => /context|too long|too many tokens|maximum.*tokens|exceed|413/i.test(String(msg))

export async function callModel(model, messages, { temperature = 0.75, maxTokens = 2500, lastChance = true } = {}) {
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
  let refused = ''
  lastBrain.declined = false
  for (let i = 0; i < attempts.length; i++) {
    const { m, t } = attempts[i]
    try {
      const reply = await callOnce(m, messages, { temperature: t, maxTokens })
      // This brain refused to be Lucian — skip straight to his other brain
      if (looksLikeRefusal(reply)) { refused = reply; if (i === 0) i++; continue }
      if (!looksBroken(reply)) { lastBrain.model = m; lastBrain.backup = m !== model; return reply }
      lastReply = reply // garbled — try the next attempt
    } catch (err) {
      lastError = err
      // Too much for his main brain to read? Don't hand it to the backup — let Light give him less to read and try him again
      if (i === 0 && !lastChance && tooBigError(err.message)) throw err
      // Main brain is down (not just garbled): skip the calmer retry and go straight to the backup.
      if (i === 0) i++
    }
  }
  if (lastReply) return lastReply // garbled every time — better something than nothing
  if (refused) { lastBrain.declined = true; lastBrain.model = model; return refused } // every brain refused — Light labels it
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
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }))
  return `${clock} (${partOfDay(hour)})`
}

// ---------- Voice ----------
export const DEFAULT_VOICE = { model: 'Kokoro-82m', voice: 'bm_george', speed: 1, instructions: '' }

export async function getVoice() {
  const v = await getJSON(KEYS.voice, {})
  return { ...DEFAULT_VOICE, ...v }
}

// ---------- Eyes: describe a photo for Lucian ----------
export const DEFAULT_EYES = 'qwen/qwen2.5-vl-72b-instruct'

export async function describeImage(dataUrl, caption = '') {
  const eyes = (await redis('GET', KEYS.eyesModel).catch(() => null)) || DEFAULT_EYES
  const prompt = `Describe this image in rich, accurate detail for someone who cannot see it. Include everything visible: people (appearance, expression, clothing, pose), setting, objects, colours, lighting, mood, and any text exactly as written. If it shows clothing or a product (e.g. a dress in a shop screenshot), describe the item in detail: colour, pattern, cut and shape, neckline, sleeves, length, fabric and how it looks like it would fit and move — plus the shop, product name, sizes and price if they're shown. Be factual — only describe what is really there.${caption ? ` The person sharing it said: "${caption}"` : ''}`
  try {
    return await callOnce(eyes, [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }], { temperature: 0.2, maxTokens: 900 })
  } catch (err) {
    throw new Error(`He couldn't see the photo (${err.message}). Try again, or pick a different "eyes" model in Settings → Brain.`)
  }
}

// ---------- Streaming: get his reply word by word, so a call can start speaking straight away ----------
// onText(piece) is called with each new bit of visible text. Returns the whole reply (cleaned).
export async function callStream(model, messages, { temperature = 0.75, maxTokens = 2500, onText } = {}) {
  const r = await fetch(NANO_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${NANO_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, temperature, max_tokens: maxTokens, top_p: 0.9, frequency_penalty: 0.3, stream: true,
    }),
  })
  const type = r.headers.get('content-type') || ''
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    let msg = t.slice(0, 300)
    try { const d = JSON.parse(t); msg = d.error?.message || d.error || msg } catch {}
    throw new Error('NanoGPT: ' + msg)
  }
  // Not streaming after all — treat it like a normal reply
  if (!type.includes('event-stream')) {
    const d = await r.json()
    const reply = cleanReply(String(d.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim())
    if (!reply) throw new Error('He went quiet — the model sent back an empty reply.')
    onText?.(reply)
    return reply
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = '', raw = '', shown = 0
  const visible = () => {
    // hide private <think> reasoning, even while it's still being written
    let v = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
    const open = v.search(/<think>/i)
    if (open >= 0) v = v.slice(0, open)
    return v.replace(/^\s+/, '')
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const l = line.trim()
      if (!l.startsWith('data:')) continue
      const data = l.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const j = JSON.parse(data)
        if (j.error) throw new Error('NanoGPT: ' + (j.error.message || j.error))
        const piece = j.choices?.[0]?.delta?.content
        if (piece) {
          raw += piece
          const v = visible()
          if (v.length > shown) { onText?.(v.slice(shown)); shown = v.length }
        }
      } catch (err) { if (/NanoGPT/.test(err.message)) throw err }
    }
  }
  const reply = cleanReply(visible().trim())
  if (!reply) throw new Error('He went quiet — the model sent back an empty reply.')
  return reply
}
