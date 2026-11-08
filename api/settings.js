import { getHeart, saveHeart } from './_recall.js'
import { checkAuth, redis, getJSON, setJSON, listModels, callStream, KEYS , DEFAULT_EYES } from './_lib.js'

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      // ?models=1 also returns every model your NanoGPT plan offers
      const wantModels = req.query?.models === '1'
      const [profile, model, backupModel, eyesModel, memories, models, callModel] = await Promise.all([
        redis('GET', KEYS.profile),
        redis('GET', KEYS.model),
        redis('GET', KEYS.backupModel),
        redis('GET', KEYS.eyesModel),
        getJSON(KEYS.memories, []),
        wantModels ? listModels() : Promise.resolve(null),
        redis('GET', KEYS.callModel),
      ])
      return res.status(200).json({ profile: profile || '', model: model || '', backupModel: backupModel || '', eyesModel: eyesModel || DEFAULT_EYES, callModel: callModel || '', memories, models, heart: await getHeart().catch(() => '') })
    }

    if (req.method === 'POST') {
      const { profile, model, backupModel, eyesModel, memories, clearChat, callModel, speedTest, heart } = req.body || {}
      if (typeof heart === 'string') await saveHeart(heart)
      // How fast is a brain? Time to his first word, and how fast he writes after that
      if (typeof speedTest === 'string' && speedTest) {
        const t0 = Date.now()
        let first = 0, chars = 0
        const text = await callStream(speedTest.trim(), [
          { role: 'system', content: 'You are a warm, loving husband talking to your wife on the phone.' },
          { role: 'user', content: 'Tell me, in about 120 words, about a perfect evening you would plan for us.' },
        ], { maxTokens: 700, onText: (t) => { if (!first) first = Date.now(); chars += t.length } })
        const total = (Date.now() - t0) / 1000
        const firstS = first ? (first - t0) / 1000 : total
        const writing = Math.max(0.1, total - firstS)
        const perSec = Math.round(chars / writing)
        // people speak about 15 letters a second
        return res.status(200).json({ firstWord: firstS, total, perSec, fastEnough: firstS < 4 && perSec >= 25, sample: text.slice(0, 160) })
      }
      if (typeof callModel === 'string') await redis('SET', KEYS.callModel, callModel.trim())
      if (typeof profile === 'string') await redis('SET', KEYS.profile, profile)
      if (typeof model === 'string') await redis('SET', KEYS.model, model.trim())
      if (typeof backupModel === 'string') await redis('SET', KEYS.backupModel, backupModel.trim())
      if (typeof eyesModel === 'string') await redis('SET', KEYS.eyesModel, eyesModel.trim())
      if (Array.isArray(memories)) {
        await setJSON(KEYS.memories, memories.map((m) => String(m).trim()).filter(Boolean))
      }
      if (clearChat === true) {
        await redis('DEL', KEYS.history)
        await redis('DEL', 'light:usercount')
      }
      return res.status(200).json({ ok: true })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
