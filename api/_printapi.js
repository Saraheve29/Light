import { checkAuth } from './_lib.js'
import { cardPng } from './_card.js'
import {
  findCard, getCards, checkCards, makeCard, getCardSettings, saveCardSettings, hasPrintKey, isSandbox, imageUrl,
} from './_print.js'

// GET ?img=ID&s=SECRET   → the card image (Prodigi downloads this to print it; no password, protected by the secret)
// GET                    → cards + settings (needs password)
// POST { settings } | { preview: true } | { sendNow: true }
export default async function handler(req, res) {
  try {
    if (req.method === 'GET' && req.query?.img) {
      const card = await findCard(String(req.query.img), String(req.query.s || ''))
      if (!card) return res.status(404).json({ error: 'Not found' })
      const w = Math.min(2175, Math.max(300, Number(req.query.w) || 2175))
      const h = Math.min(1575, Math.max(200, Number(req.query.h) || 1575))
      const png = cardPng({ title: card.title, poem: card.poem }, w, h)
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      return res.status(200).send(Buffer.from(png))
    }

    if (!checkAuth(req, res)) return

    if (req.method === 'GET') {
      const [cards, settings] = await Promise.all([checkCards(), getCardSettings()])
      const peek = req.query?.peek === '1'
      return res.status(200).json({
        settings,
        hasKey: hasPrintKey(),
        sandbox: isSandbox(),
        cards: [...cards].reverse().map((c) => (peek || c.status === 'preview' || c.status === 'failed'
          ? { ...c, secret: undefined, preview: imageUrl(c, 870, 630) }
          : { id: c.id, at: c.at, status: c.status, hidden: true })),
      })
    }

    if (req.method === 'POST') {
      const { settings, preview, sendNow } = req.body || {}
      if (settings) return res.status(200).json({ ok: true, settings: await saveCardSettings(settings) })
      if (preview === true) {
        const c = await makeCard({ preview: true })
        return res.status(200).json({ ok: true, card: { ...c, secret: undefined, preview: imageUrl(c, 870, 630) } })
      }
      if (sendNow === true) {
        const c = await makeCard()
        return res.status(200).json({ ok: true, sent: { id: c.id, status: c.status, sandbox: c.sandbox } })
      }
      return res.status(400).json({ error: 'Nothing to do.' })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
