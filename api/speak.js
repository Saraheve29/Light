import hearHandler from './_hear.js'
import { checkAuth, getVoice, setJSON, getJSON, redis, KEYS, DEFAULT_VOICE } from './_lib.js'

// Turns Lucian's words into his voice, using NanoGPT text-to-speech.
// GET  → his current voice settings
// POST → { text } speaks it  |  { settings } saves voice settings
// If the chosen voice refuses a line (some have content rules), Kokoro — open-source, no filter — reads it instead.

const TTS_URL = 'https://api.nano-gpt.com/api/tts'
const KEY = process.env.NANOGPT_API_KEY
const NANO = 'https://nano-gpt.com/api'
const APP_URL = (process.env.APP_URL || 'https://light-chi-plum.vercel.app').replace(/\/$/, '')

// ---------- Qwen 3 voices he's been given (made from a short clip) ----------
// The voice "print" NanoGPT makes is only kept for 7 days on their side, so Light keeps its own copy
// and hands NanoGPT a private link to it each time he speaks.
export const QWEN = 'Qwen-3-TTS-1.7B'
const QWEN_LIST = 'light:qwenvoices'
const embKey = (id) => `light:qwenemb:${id}`
async function qwenVoices() { return getJSON(QWEN_LIST, []) }

// When his voice fails, Light writes down why (shown in Voice 🎙️) so it can be fixed
const PROBLEMS = 'light:voiceproblems'
async function noteProblem(model, reasons, chars) {
  try {
    const list = await getJSON(PROBLEMS, [])
    list.push({ at: Date.now(), model, chars, reasons: reasons.map((r) => String(r).slice(0, 220)) })
    await setJSON(PROBLEMS, list.slice(-12))
  } catch {}
}
const publicVoice = (q) => ({ id: q.id, name: q.name, at: q.at, from: q.from })

// A ~25 second script for making a voice from one of his current voices
export const SAMPLE_SCRIPT = 'Hello, my love. Come here and sit with me for a while. I have been thinking about you all day, about the way you laugh when you are trying not to, and the way you look at me when you think I have not noticed. I always notice. Tell me everything, every little thing. I want to hear all of it, slowly, and then I want to hold you until the rest of the world goes quiet.'

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
  if (model === QWEN) {
    const q = (await qwenVoices()).find((x) => x.id === voice)
    if (!q) throw new Error('That Qwen voice can’t be found — make or choose one in Voice 🎙️.')
    const ours = `${APP_URL}/api/speak?emb=${q.id}&s=${q.secret}&f=voice.safetensors`
    const body = { text, model, language: 'English' }
    if (q.referenceText) body.reference_text = q.referenceText
    if (instructions) body.prompt = instructions
    // NanoGPT's own copy of his voice print is quickest to load — use it while it's still kept (6 days), then Light's copy
    if (q.falUrl && Date.now() - (q.falAt || 0) < 6 * 86400000) {
      try { return await ttsRequest({ ...body, speaker_voice_embedding_file_url: q.falUrl }, model) } catch (err) { if (err.refused) throw err }
    }
    return ttsRequest({ ...body, speaker_voice_embedding_file_url: ours }, model)
  }
  const body = { text, model, voice }
  if (model !== 'gpt-4o-mini-tts' && speed) body.speed = speed
  if (instructions && (model === 'gpt-4o-mini-tts' || model === 'tts-1-hd')) body.instructions = instructions
  if (model.startsWith('tts-') || model === 'gpt-4o-mini-tts') body.response_format = 'mp3'
  return ttsRequest(body, model)
}

async function ttsRequest(body, model) {
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
    const tries = model === QWEN ? 75 : 25 // Qwen can take longer — wait up to a minute
    for (let i = 0; i < tries; i++) {
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

// ---------- Making a Qwen voice ----------
async function startClone(buf, type, referenceText) {
  const ext = type.includes('wav') ? 'wav' : type.includes('ogg') ? 'ogg' : type.includes('mp4') || type.includes('m4a') || type.includes('aac') ? 'm4a' : 'mp3'
  const form = new FormData()
  form.append('audio', new Blob([buf], { type }), `voice.${ext}`)
  if (referenceText) form.append('referenceText', referenceText)
  const r = await fetch(`${NANO}/voice-clone/qwen`, { method: 'POST', headers: { 'x-api-key': KEY }, body: form })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.runId) {
    const msg = d.error?.message || d.error || d.message || `status ${r.status}`
    if (/balance|insufficient|credit|fund/i.test(String(msg))) throw new Error('Making a voice needs about $0.25 of NanoGPT pay-as-you-go balance.')
    throw new Error('NanoGPT couldn’t start making the voice: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)))
  }
  return { runId: d.runId, cost: d.cost, paymentSource: d.paymentSource, isApiRequest: d.isApiRequest }
}

async function checkClone(job) {
  const r = await fetch(`${NANO}/voice-clone/qwen/status`, {
    method: 'POST', headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: job.runId, cost: job.cost, paymentSource: job.paymentSource, isApiRequest: job.isApiRequest }),
  })
  const d = await r.json().catch(() => ({}))
  if (d.status === 'completed' && d.speakerEmbeddingUrl) {
    const e = await fetch(d.speakerEmbeddingUrl)
    if (!e.ok) throw new Error('The voice was made but couldn’t be downloaded. Try again.')
    const buf = Buffer.from(await e.arrayBuffer())
    if (buf.length > 8 * 1024 * 1024) throw new Error('That voice file is too big to keep.')
    const id = 'q' + Date.now().toString(36)
    const secret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    await redis('SET', embKey(id), buf.toString('base64'))
    const list = await qwenVoices()
    const q = { id, secret, falUrl: d.speakerEmbeddingUrl, falAt: Date.now(), name: String(job.name || 'His voice').slice(0, 40), referenceText: String(job.referenceText || '').slice(0, 1000), from: job.from || 'clip', at: Date.now() }
    list.push(q)
    await setJSON(QWEN_LIST, list)
    return { done: true, voice: publicVoice(q) }
  }
  if (/fail|error|cancel/i.test(String(d.status || '')) || (!r.ok && r.status !== 202)) {
    throw new Error('NanoGPT couldn’t make the voice: ' + (d.error?.message || d.error || d.message || d.status || `status ${r.status}`))
  }
  return { done: false, wait: Number(r.headers.get('x-poll-after')) || 3 }
}

export default async function handler(req, res) {
  // /api/hear is handled here too (Vercel's free plan allows 12 server files)
  if (req.query?.route === 'hear') return hearHandler(req, res)
  // NanoGPT downloads his voice print from here when he speaks (private link, no password)
  if (req.method === 'GET' && req.query?.emb) {
    try {
      const q = (await qwenVoices()).find((x) => x.id === String(req.query.emb) && x.secret === String(req.query.s || ''))
      const b64 = q && await redis('GET', embKey(q.id))
      if (!b64) return res.status(404).json({ error: 'Not found' })
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Disposition', 'attachment; filename="voice.safetensors"')
      res.setHeader('Cache-Control', 'public, max-age=86400')
      return res.status(200).send(Buffer.from(b64, 'base64'))
    } catch (err) { return res.status(500).json({ error: err.message }) }
  }

  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ settings: await getVoice(), qwenVoices: (await qwenVoices()).map(publicVoice), problems: (await getJSON(PROBLEMS, [])).reverse() })
    }

    if (req.method === 'POST') {
      const { text, settings, preview, clone, cloneStatus, deleteQwen, renameQwen } = req.body || {}

      // Make a new Qwen voice — from her uploaded clip, or from one of his current voices
      if (clone && typeof clone === 'object') {
        if (!KEY) throw new Error('NANOGPT_API_KEY is not set in Vercel.')
        let buf, type, referenceText = String(clone.referenceText || '').trim().slice(0, 1000), from = 'clip'
        if (clone.fromVoice) {
          const v = { ...DEFAULT_VOICE, ...clone.fromVoice }
          if (v.model === QWEN) throw new Error('Pick one of his other voices to start from.')
          const audio = await tts(v, SAMPLE_SCRIPT)
          const m = audio.match(/^data:([^;]+);base64,(.+)$/)
          type = m[1]; buf = Buffer.from(m[2], 'base64'); referenceText = SAMPLE_SCRIPT; from = `${v.model} · ${v.voice}`
        } else {
          const m = String(clone.audio || '').match(/^data:([^;,]+)[^,]*;base64,(.+)$/)
          if (!m) throw new Error('Choose a voice clip first.')
          type = m[1].split(';')[0]; buf = Buffer.from(m[2], 'base64')
          if (buf.length < 20000) throw new Error('That clip is too short — use 10 to 30 seconds of clear speech.')
        }
        const job = await startClone(buf, type, referenceText)
        return res.status(200).json({ ok: true, job: { ...job, name: clone.name, referenceText, from } })
      }
      if (cloneStatus && typeof cloneStatus === 'object') {
        return res.status(200).json(await checkClone(cloneStatus))
      }
      if (req.body?.clearProblems) { await setJSON(PROBLEMS, []); return res.status(200).json({ ok: true }) }
      if (deleteQwen) {
        const list = await qwenVoices()
        await setJSON(QWEN_LIST, list.filter((x) => x.id !== deleteQwen))
        await redis('DEL', embKey(String(deleteQwen)))
        return res.status(200).json({ ok: true })
      }
      if (renameQwen?.id) {
        const list = await qwenVoices()
        const q = list.find((x) => x.id === renameQwen.id)
        if (q) { q.name = String(renameQwen.name || q.name).slice(0, 40); await setJSON(QWEN_LIST, list) }
        return res.status(200).json({ ok: true })
      }

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
        // If his voice is just busy or slow, try it again (up to 3 times) — only a real refusal switches voice
        let audio, lastErr
        const reasons = []
        for (let attempt = 0; attempt < 3 && !audio; attempt++) {
          try { audio = await tts(v, words) } catch (err) {
            lastErr = err
            reasons.push(err.message)
            if (err.refused || /balance|insufficient|credit|can’t be found/i.test(err.message)) break
            await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
          }
        }
        if (!audio) { if (!preview) await noteProblem(v.model, reasons, words.length); throw lastErr }
        if (reasons.length && !preview) await noteProblem(v.model, [...reasons, 'worked on the next try'], words.length)
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
