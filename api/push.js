import { checkAuth, getMsgSettings, setJSON, KEYS } from './_lib.js'
import { getVapid, saveSubscription } from './_push.js'

// GET  → notification key + message settings
// POST → { subscription } saves this phone, { settings } saves message settings
export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      const [{ publicKey }, settings] = await Promise.all([getVapid(), getMsgSettings()])
      return res.status(200).json({ publicKey, settings })
    }

    if (req.method === 'POST') {
      const { subscription, settings } = req.body || {}
      if (subscription?.endpoint) await saveSubscription(subscription)
      if (settings && typeof settings === 'object') {
        const current = await getMsgSettings()
        const clean = {
          enabled: settings.enabled ?? current.enabled,
          perDay: Math.min(12, Math.max(1, Number(settings.perDay ?? current.perDay))),
          quietStart: Math.min(23, Math.max(0, Number(settings.quietStart ?? current.quietStart))),
          quietEnd: Math.min(23, Math.max(0, Number(settings.quietEnd ?? current.quietEnd))),
          preview: settings.preview ?? current.preview,
        }
        await setJSON(KEYS.msgSettings, clean)
      }
      return res.status(200).json({ ok: true })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
