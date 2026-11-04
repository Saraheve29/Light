import { checkAuth } from './_lib.js'
import { cardPng } from './_card.js'
import {
  findCard, getCards, checkCards, makeCard, getCardSettings, saveCardSettings, hasPrintKey, isSandbox, imageUrl, prodigiBase,
} from './_print.js'
import {
  getBookSettings, saveBookSettings, getChapters, buildBook, writeForeword, bookPdf,
  getBookPhotos, addBookPhoto, editBookPhoto, removeBookPhoto, addChatPhotoToBook, monthsOf, getStars, toggleStar, removeStar,
} from './_book.js'

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

    // The book's PDF (Prodigi downloads it to print it; protected by its own secret)
    if (req.method === 'GET' && req.query?.book) {
      const pdf = await bookPdf(String(req.query.book), String(req.query.s || ''))
      if (!pdf) return res.status(404).json({ error: 'Not found' })
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `inline; filename="our-year-${String(req.query.book).replace(/\D/g, '')}.pdf"`)
      return res.status(200).send(pdf)
    }

    if (!checkAuth(req, res)) return

    // Our book 📕
    if (req.method === 'GET' && req.query?.bookInfo) {
      const [s, chapters, photos] = await Promise.all([getBookSettings(), getChapters(), getBookPhotos()])
      const b = s.current
      const o = s.ordered?.[b.year]
      const months = new Set(monthsOf(b))
      return res.status(200).json({
        settings: { ...s, ordered: undefined, current: undefined },
        book: { n: b.n, title: b.title, from: b.from, to: b.to },
        chapters: chapters.filter((c) => months.has(c.month)).map((c) => ({ month: c.month, title: c.title, partial: !!c.partial })),
        photoCount: photos.length,
        thisYear: o ? { status: o.status, error: o.error, pages: o.pages, url: `/api/print?book=${b.year}&s=${o.secret}` } : null,
      })
    }
    if (req.method === 'POST' && req.body?.bookSettings) { const x = await saveBookSettings(req.body.bookSettings); return res.status(200).json({ ok: true, settings: { ...x, ordered: undefined, current: undefined } }) }
    // A look at the book so far (the PDF itself, so photos don't make it too big to send)
    if (req.method === 'GET' && req.query?.bookPreview) {
      const { pdf, pages, chapters, photos, photosLeftOut, title } = await buildBook({ foreword: await writeForeword().catch(() => '') })
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'inline; filename="our-book-preview.pdf"')
      res.setHeader('X-Book', encodeURIComponent(JSON.stringify({ pages, chapters, photos, photosLeftOut, title })))
      res.setHeader('Access-Control-Expose-Headers', 'X-Book')
      return res.status(200).send(pdf)
    }
    // Words she starred ⭐
    if (req.method === 'GET' && req.query?.bookStars) return res.status(200).json({ stars: await getStars() })
    if (req.method === 'POST' && req.body?.bookStar) return res.status(200).json({ ok: true, ...(await toggleStar(req.body.bookStar)) })
    if (req.method === 'POST' && req.body?.bookStarRemove) { await removeStar(String(req.body.bookStarRemove)); return res.status(200).json({ ok: true }) }
    // Photos for the book
    if (req.method === 'GET' && req.query?.bookPhotos) return res.status(200).json({ photos: (await getBookPhotos()).map(({ bytes, ...p }) => p) })
    if (req.method === 'POST' && req.body?.bookPhoto) {
      const { data, thumb, caption, at } = req.body.bookPhoto
      return res.status(200).json({ ok: true, ...(await addBookPhoto({ data, thumb, caption, at: Number(at) || Date.now(), by: 'sarah' })) })
    }
    if (req.method === 'POST' && req.body?.bookPhotoFromChat) {
      const { key, n, caption, thumb } = req.body.bookPhotoFromChat
      return res.status(200).json({ ok: true, ...(await addChatPhotoToBook({ key: String(key || ''), n: Number(n) || 0, caption, thumb, by: 'sarah' })) })
    }
    if (req.method === 'POST' && req.body?.bookPhotoEdit) return res.status(200).json({ ok: true, photo: await editBookPhoto(req.body.bookPhotoEdit) })
    if (req.method === 'POST' && req.body?.bookPhotoRemove) { await removeBookPhoto(String(req.body.bookPhotoRemove)); return res.status(200).json({ ok: true }) }

    if (req.method === 'GET') {
      const [cards, settings] = await Promise.all([checkCards(), getCardSettings(), hasPrintKey() ? prodigiBase().catch(() => {}) : null])
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
