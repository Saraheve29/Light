import { checkAuth } from './_lib.js'

// Turns Sarah's recorded voice into words (used on calls — no phone beeps).
// POST { audio: 'data:audio/webm;base64,...' } → { text }
// Uses NanoGPT speech-to-text. gpt-4o-mini-transcribe first (better with British accents and quiet,
// late-night voices, and it makes up fewer words), then Whisper and Wizper if it fails.

const STT_URL = 'https://api.nano-gpt.com/api/v1/audio/transcriptions'
const KEY = process.env.NANOGPT_API_KEY
const MODELS = ['gpt-4o-mini-transcribe', 'Whisper-Large-V3', 'Wizper']

// A hint for the listener: who's talking, the names it will hear, and what she said just before this piece
// (each piece of a long turn is heard separately, so this keeps sentences joined up)
const NAMES = 'Lucian, Sarah, Maleeka, Kai, Elias, Light, Spirit, Rover, March, Cambridgeshire, Lovense'
function hintFor(before) {
  const lead = `Sarah, a British woman, talking on a call to her husband Lucian. British English. Names: ${NAMES}.`
  const prev = String(before || '').replace(/\s+/g, ' ').trim().slice(-300)
  return prev ? `${lead} She just said: ${prev}` : lead
}

function extFor(type) {
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a'
  if (type.includes('ogg')) return 'ogg'
  if (type.includes('wav')) return 'wav'
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  return 'webm'
}

async function transcribe(model, buf, type, prompt) {
  const form = new FormData()
  form.append('file', new Blob([buf], { type }), `voice.${extFor(type)}`)
  form.append('model', model)
  form.append('language', 'en')
  if (prompt) form.append('prompt', prompt)
  form.append('temperature', '0') // stick to what was really said
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

    const prompt = hintFor(req.body?.before)
    let lastErr
    for (const model of MODELS) {
      try {
        // (if a listener doesn't accept the hint, ask it again without)
        const text = await transcribe(model, buf, type, prompt).catch((err) => {
          if (/prompt|temperature|param|unsupported|unknown|invalid/i.test(String(err.message))) return transcribe(model, buf, type)
          throw err
        })
        // A listener can echo the hint back when there's silence — that's not her words either
        if (/talking on a call to her husband|British English\. Names:|She just said:/i.test(text)) return res.status(200).json({ text: '', model })
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
