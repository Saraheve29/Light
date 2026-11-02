import { checkAuth } from './_lib.js'
import printHandler from './_printapi.js'
import { getLetters, getLetterSettings, saveLetterSettings, writeLetter } from './_letters.js'

// GET  → his letters (newest first) and the letter schedule
// POST → { settings } | { writeNow: true }
export default async function handler(req, res) {
  // /api/print (poem cards) is handled here too (Vercel's free plan allows 12 server files)
  if (req.query?.route === 'print') return printHandler(req, res)
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      const [letters, settings] = await Promise.all([getLetters(), getLetterSettings()])
      return res.status(200).json({ letters: [...letters].reverse(), settings })
    }

    if (req.method === 'POST') {
      const { settings, writeNow } = req.body || {}
      if (settings) return res.status(200).json({ ok: true, settings: await saveLetterSettings(settings) })
      if (writeNow === true) return res.status(200).json({ ok: true, letter: await writeLetter() })
      return res.status(400).json({ error: 'Nothing to do.' })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
