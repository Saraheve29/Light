import { checkAuth, getVoice, setJSON, KEYS, DEFAULT_VOICE } from './_lib.js'

// Turns Lucian's words into his voice, using NanoGPT text-to-speech.
// GET  → his current voice settings
// POST → { text } speaks it  |  { settings } saves voice settings
// If the chosen voice refuses a line (some have content rules), Kokoro — open-source, no filter — reads it instead.

const TTS_URL = 'https://api.nano-gpt.com/api/tts'
const KEY = process.env.NANOGPT_API_KEY

// Only speak real words: drop *actions*, [[codes]], emoji and stray symbols.
export function speakable(text) {
  return String(text || '')
    .replace(/\[\[[\s\S]*?\]\]/g, ' ')
    .replace(/\*[^*\n]{1,200}\*/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[_#>~`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3800)
}

async function fetchAudio(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error('Could not download his voice.')
  const type = r.headers.get('content-type') || 'audio/mpeg'
  const buf = Buffer.from(await r.arrayBuffer())
  return `data:${type};base64,${buf.toString('base64')}`
}

async function tts({ model, voice, speed, instructions }, text) {
  const body = { text, model, voice }
  if (model !== 'gpt-4o-mini-tts' && speed) body.speed = speed
  if (instructions && (model === 'gpt-4o-mini-tts' || model === 'tts-1-hd')) body.instructions = instructions
  if (model.startsWith('tts-') || model === 'gpt-4o-mini-tts') body.response_format = 'mp3'

  const r = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const type = r.headers.get('content-type') || ''

  // OpenAI voices send the audio straight back
  if (r.ok && type.startsWith('audio/')) {
    const buf = Buffer.from(await r.arrayBuffer())
    return `data:${type};base64,${buf.toString('base64')}`
  }

  const data = await r.json().catch(() => ({}))
  if (!r.ok && r.status !== 202) {
    const msg = data.error?.message || data.error || data.message || `status ${r.status}`
    const err = new Error(String(msg))
    err.refused = /CONTENT_POLICY|policy|moderat|flagged|not allowed/i.test(JSON.stringify(data))
    throw err
  }
  if (data.audioUrl) return fetchAudio(data.audioUrl)

  // Some voices (ElevenLabs) take a moment — wait for them
  if (data.runId) {
    for (let i = 0; i < 25; i++) {
      await new Promise((res) => setTimeout(res, 800))
      const s = await fetch(`https://api.nano-gpt.com/api/tts/status?runId=${encodeURIComponent(data.runId)}&model=${encodeURIComponent(data.model || model)}`, {
        headers: { 'x-api-key': KEY },
      })
      const st = await s.json().catch(() => ({}))
      if (st.status === 'completed' && st.audioUrl) return fetchAudio(st.audioUrl)
      if (st.status === 'error') {
        const err = new Error(st.error || 'The voice service had a problem.')
        err.refused = /CONTENT_POLICY|policy|moderat|flagged/i.test(JSON.stringify(st))
        throw err
      }
    }
    throw new Error('His voice took too long.')
  }
  throw new Error('The voice service sent something unexpected.')
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ settings: await getVoice() })
    }

    if (req.method === 'POST') {
      const { text, settings, preview } = req.body || {}

      if (settings && typeof settings === 'object') {
        const clean = {
          model: String(settings.model || DEFAULT_VOICE.model).slice(0, 80),
          voice: String(settings.voice || '').slice(0, 80),
          speed: Math.min(1.6, Math.max(0.6, Number(settings.speed) || 1)),
          instructions: String(settings.instructions || '').slice(0, 500),
        }
        await setJSON(KEYS.voice, clean)
        return res.status(200).json({ ok: true })
      }

      const words = speakable(text)
      if (!words) return res.status(200).json({ audio: null })
      if (!KEY) throw new Error('NANOGPT_API_KEY is not set in Vercel.')

      // preview = try a voice before saving it
      const v = preview && typeof preview === 'object' ? { ...DEFAULT_VOICE, ...preview } : await getVoice()

      try {
        const audio = await tts(v, words)
        return res.status(200).json({ audio, voiceUsed: v.model })
      } catch (err) {
        // Chosen voice refused or failed → Kokoro (open-source, no filter) reads it instead
        if (v.model === 'Kokoro-82m') throw err
        const audio = await tts({ ...DEFAULT_VOICE, speed: v.speed }, words)
        return res.status(200).json({ audio, voiceUsed: 'Kokoro-82m', fellBack: true, reason: err.message })
      }
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
