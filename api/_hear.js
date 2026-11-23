import { checkAuth } from './_lib.js'

// Turns Sarah's recorded voice into words (used on calls — no phone beeps).
// POST { audio: 'data:audio/webm;base64,...' } → { text }
// Uses NanoGPT speech-to-text. gpt-4o-mini-transcribe first (better with British accents and quiet,
// late-night voices, and it makes up fewer words), then Whisper and Wizper if it fails.

const STT_URL = 'https://api.nano-gpt.com/api/v1/audio/transcriptions'
const KEY = process.env.NANOGPT_API_KEY
const MODELS = ['gpt-4o-mini-transcribe', 'Whisper-Large-V3', 'Wizper']

// No hints or descriptions are given to the listener any more: when a piece is silent, a hint like
// "Sarah talking to her husband Lucian" made it invent whole fake conversations. It writes only what it hears.

// Signs the listener has invented words rather than heard them
function looksInvented(text, seconds) {
  const t = String(text || '')
  if (/\b(Sarah|Lucian|Speaker \d|Person [AB])\s*:/i.test(t)) return 'it wrote a script with names'
  const words = t.split(/\s+/).filter(Boolean).length
  if (seconds > 0 && words > seconds * 5 + 12) return 'far more words than she had time to say'
  const lines = t.split(/(?<=[.!?])\s+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 8)
  const counts = {}
  for (const l of lines) counts[l] = (counts[l] || 0) + 1
  // ("I love you. I love you. I love you." can be real — a long sentence looping, or anything 5+ times, isn't)
  if (Object.entries(counts).some(([l, n]) => n >= 5 || (n >= 3 && l.length >= 25))) return 'the same sentence over and over'
  return ''
}

function extFor(type) {
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a'
  if (type.includes('ogg')) return 'ogg'
  if (type.includes('wav')) return 'wav'
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  return 'webm'
}

async function transcribe(model, buf, type, { bare = false } = {}) {
  const form = new FormData()
  form.append('file', new Blob([buf], { type }), `voice.${extFor(type)}`)
  form.append('model', model)
  form.append('language', 'en')
  if (!bare) form.append('temperature', '0') // stick to what was really said
  const r = await fetch(STT_URL, { method: 'POST', headers: { 'x-api-key': KEY }, body: form })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || data?.message || `status ${r.status}`
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return String(data.text ?? data.transcription ?? '').trim()
}

// Made-up words that appear when there's silence, noise or no microphone: "you", "bye", "(claps)", "[Music]"…
function notReallySaid(text) {
  const t = String(text || '')
    .replace(/[\[(（][^\])）]{0,40}[\])）]/g, ' ') // (claps) [applause] [Music]
    .replace(/[♪♫*…]/g, ' ')
    .toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return true
  const fillers = new Set(['you', 'bye', 'bye bye', 'goodbye', 'thank you', 'thanks', 'thank you very much', 'thanks for watching', 'thank you for watching', 'please subscribe', 'see you', 'see you next time', 'okay', 'oh', 'um', 'uh', 'hmm', 'so', 'yeah', 'the end', 'subtitles by the amara org community'])
  const parts = t.split(/ (?=you|bye)/)
  if (fillers.has(t)) return true
  // "bye you bye" — only filler words, repeated
  return t.split(' ').every((w) => ['you', 'bye', 'thank', 'thanks', 'claps', 'clapping', 'applause', 'music', 'oh', 'um', 'uh'].includes(w)) && parts.length >= 1
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  try {
    const m = String(req.body?.audio || '').match(/^data:([^;,]+)[^,]*;base64,(.+)$/)
    if (!m) return res.status(400).json({ error: 'No recording received.' })
    const type = m[1].split(';')[0]
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length < 1200) return res.status(200).json({ text: '' }) // too short to hold words

    const seconds = (buf.length * 8) / 32000 // recorded at about 32 kbps
    let lastErr
    for (const model of MODELS) {
      try {
        const text = await transcribe(model, buf, type).catch((err) => {
          if (/temperature|param|unsupported|unknown|invalid/i.test(String(err.message))) return transcribe(model, buf, type, { bare: true })
          throw err
        })
        // Invented words (a made-up script, a loop, far too many words) are thrown away, never shown as hers
        if (looksInvented(text, seconds)) return res.status(200).json({ text: '', model, ignored: looksInvented(text, seconds) })
        // Voice-to-words services sometimes "hear" these in silence or noise — they're not her words
        return res.status(200).json({ text: notReallySaid(text) ? '' : text, model })
      } catch (err) { lastErr = err }
    }
    const msg = String(lastErr?.message || '')
    if (/balance|insufficient|credit|fund/i.test(msg)) {
      return res.status(402).json({ error: 'Turning your voice into words needs a little NanoGPT pay-as-you-go balance (the same balance his voice uses).' })
    }
    res.status(502).json({ error: 'Couldn’t make out the recording: ' + msg })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
