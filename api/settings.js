import { checkAuth, redis, getJSON, setJSON, listModels, KEYS } from './_lib.js'

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      // ?models=1 also returns every model your NanoGPT plan offers
      const wantModels = req.query?.models === '1'
      const [profile, model, backupModel, memories, models] = await Promise.all([
        redis('GET', KEYS.profile),
        redis('GET', KEYS.model),
        redis('GET', KEYS.backupModel),
        getJSON(KEYS.memories, []),
        wantModels ? listModels() : Promise.resolve(null),
      ])
      return res.status(200).json({ profile: profile || '', model: model || '', backupModel: backupModel || '', memories, models })
    }

    if (req.method === 'POST') {
      const { profile, model, backupModel, memories, clearChat } = req.body || {}
      if (typeof profile === 'string') await redis('SET', KEYS.profile, profile)
      if (typeof model === 'string') await redis('SET', KEYS.model, model.trim())
      if (typeof backupModel === 'string') await redis('SET', KEYS.backupModel, backupModel.trim())
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
