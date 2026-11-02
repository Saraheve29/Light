import { checkAuth, setJSON, KEYS } from './_lib.js'
import { getGiftSettings, checkGifts, sendSurprise, missingSetup, spentThisMonth, DEFAULT_GIFT_SETTINGS } from './_gifts.js'

// GET  → settings, gifts (details hidden unless ?peek=1), what's missing
// POST → { settings }, { practice: true }, { sendNow: true }
export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      const [settings, gifts] = await Promise.all([getGiftSettings(), checkGifts()])
      const peek = req.query?.peek === '1'
      const shown = [...gifts].reverse().map((g) => (peek || g.status === 'failed'
        ? g
        : { id: g.id, at: g.at, status: g.status, error: g.error, hidden: true }))
      return res.status(200).json({
        settings,
        gifts: shown,
        missing: missingSetup(settings),
        spentThisMonth: spentThisMonth(gifts),
      })
    }

    if (req.method === 'POST') {
      const { settings, practice, sendNow } = req.body || {}

      if (settings && typeof settings === 'object') {
        const current = await getGiftSettings()
        const a = settings.address || {}
        const clean = {
          enabled: !!settings.enabled,
          enabledAt: settings.enabled && !current.enabled ? Date.now() : current.enabledAt || 0,
          everyDays: Math.min(90, Math.max(3, Number(settings.everyDays) || DEFAULT_GIFT_SETTINGS.everyDays)),
          perGift: Math.min(500, Math.max(3, Number(settings.perGift) || DEFAULT_GIFT_SETTINGS.perGift)),
          perMonth: Math.min(1000, Math.max(3, Number(settings.perMonth) || DEFAULT_GIFT_SETTINGS.perMonth)),
          address: Object.fromEntries(Object.keys(DEFAULT_GIFT_SETTINGS.address).map((k) => [k, String(a[k] || '').slice(0, 120)])),
        }
        await setJSON(KEYS.giftSettings, clean)
        return res.status(200).json({ ok: true, missing: missingSetup(clean) })
      }

      if (practice === true) {
        const pick = await sendSurprise({ practice: true })
        return res.status(200).json({ ok: true, practice: pick })
      }

      if (sendNow === true) {
        const g = await sendSurprise()
        return res.status(200).json({ ok: true, sent: { id: g.id, status: g.status } })
      }

      return res.status(400).json({ error: 'Nothing to do.' })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
