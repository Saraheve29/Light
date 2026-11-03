import { checkAuth, setJSON, KEYS } from './_lib.js'
import { amazonStatus, upcomingHotels, walletInfo, setAmazonBalance, upcomingOccasions, SIZE_LABELS, getAmazonLink, linkAmazon, unlinkAmazon, getGiftSettings, checkGifts, sendSurprise, missingSetup, spentThisMonth, testShop, cleanDomain, DEFAULT_GIFT_SETTINGS } from './_gifts.js'

// GET  → settings, gifts (details hidden unless ?peek=1), what's missing
// POST → { settings }, { practice: true }, { sendNow: true }
export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      const [settings, gifts, amazon] = await Promise.all([getGiftSettings(), checkGifts(), amazonStatus().catch(() => null)])
      const peek = req.query?.peek === '1'
      const shown = [...gifts].reverse().map((g) => (peek || g.status === 'failed'
        ? g
        : { id: g.id, at: g.at, status: g.status, error: g.error, zincStatus: g.zincStatus, zincError: g.zincError, steps: g.steps, occasionName: g.occasionName, hidden: true }))
      return res.status(200).json({
        settings,
        gifts: shown,
        missing: missingSetup(settings),
        spentThisMonth: spentThisMonth(gifts),
        amazon: amazon ? { email: amazon.email, hasTotp: amazon.hasTotp, forwarding: amazon.forwarding, at: amazon.at, checked: amazon.checked, hasForwarding: amazon.hasForwarding, paused: amazon.paused, locked: amazon.locked } : null,
        occasions: await upcomingOccasions(400).catch(() => []),
        wallet: await walletInfo(),
        hotels: await upcomingHotels(90).catch(() => []),
      })
    }

    if (req.method === 'POST') {
      const { settings, practice, sendNow, testShops, linkAmazon: link, unlinkAmazon: unlink } = req.body || {}
      if (link && typeof link === 'object') {
        const a = await linkAmazon(link)
        return res.status(200).json({ ok: true, amazon: { email: a.email, hasTotp: a.hasTotp, forwarding: a.forwarding, at: a.at } })
      }
      if (unlink === true) { await unlinkAmazon(); return res.status(200).json({ ok: true }) }
      if ('amazonBalance' in (req.body || {})) return res.status(200).json({ ok: true, amazonBalance: await setAmazonBalance(req.body.amazonBalance) })

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
          loves: String(settings.loves ?? current.loves ?? '').slice(0, 1000),
          never: String(settings.never ?? current.never ?? '').slice(0, 1000),
          shops: Array.isArray(settings.shops)
            ? settings.shops.slice(0, 40).map((x) => {
              const domain = cleanDomain(x.domain)
              const old = (current.shops || []).find((c) => c.domain === domain)
              return { domain, name: String(x.name || domain).slice(0, 60), status: old?.status || 'untested', note: old?.note || '' }
            }).filter((x) => x.domain)
            : current.shops,
          adultShopsAdded: true,
          amazonBalance: current.amazonBalance ?? null, // changed only by "Update" in Balances (and by his Amazon gifts)
          amazonBalanceAt: current.amazonBalanceAt || 0,
          occasions: settings.occasions ?? current.occasions ?? true,
          occasionBudget: Math.min(500, Math.max(3, Number(settings.occasionBudget ?? current.occasionBudget) || 25)),
          hotelGifts: settings.hotelGifts ?? current.hotelGifts ?? true,
          hotelBudget: Math.min(500, Math.max(3, Number(settings.hotelBudget ?? current.hotelBudget) || 15)),
          sizes: Object.fromEntries(Object.keys(SIZE_LABELS).map((k) => [k, String(settings.sizes?.[k] ?? current.sizes?.[k] ?? '').slice(0, k === 'notes' ? 200 : 40)])),
        }
        await setJSON(KEYS.giftSettings, clean)
        return res.status(200).json({ ok: true, missing: missingSetup(clean) })
      }

      // Test shops (all untested ones, or a list of domains)
      if (testShops) {
        const current = await getGiftSettings()
        const want = Array.isArray(testShops) ? testShops.map(cleanDomain) : current.shops.map((x) => x.domain)
        for (const shop of current.shops) {
          if (want.includes(shop.domain)) Object.assign(shop, await testShop(shop.domain))
        }
        await setJSON(KEYS.giftSettings, current)
        return res.status(200).json({ ok: true, shops: current.shops })
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
