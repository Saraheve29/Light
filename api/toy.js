import { checkAuth } from './_lib.js'
import { getToy, saveToy, getQrCode, handleCallback, stopToy, runMove, toyReady, hasDevToken } from './_toy.js'

// GET  → toy status
// POST → { pair: true } QR code | { allowed: bool } | { stop: true } | { test: 'vibrate'|'rotate' } | { forget: true }
// Lovense itself also POSTs here (no password) to say which toys are connected — checked with a secret code.
export default async function handler(req, res) {
  try {
    // Callback from Lovense Remote (it can't send Sarah's password, so it's verified by the pairing code instead)
    if (req.method === 'POST' && !req.headers['x-light-key'] && req.body?.utoken) {
      const ok = await handleCallback(req.body)
      return res.status(ok ? 200 : 403).json({ ok })
    }

    if (!checkAuth(req, res)) return

    if (req.method === 'GET') {
      const t = await getToy()
      return res.status(200).json({
        hasDevToken: hasDevToken(),
        allowed: t.allowed,
        toys: Object.values(t.toys || {}),
        connectedAt: t.connectedAt,
        ready: toyReady(t),
        lastCommand: t.lastCommand,
      })
    }

    if (req.method === 'POST') {
      const { pair, allowed, stop, test, forget } = req.body || {}

      if (stop) { await stopToy(); return res.status(200).json({ ok: true }) }

      if (pair) return res.status(200).json(await getQrCode())

      if (typeof allowed === 'boolean') {
        const t = await getToy()
        t.allowed = allowed
        await saveToy(t)
        if (!allowed) await stopToy().catch(() => {})
        return res.status(200).json({ ok: true })
      }

      if (test) {
        const move = test === 'rotate' ? { rotate: 4, seconds: 3 } : { vibrate: 4, seconds: 3 }
        await runMove(move)
        return res.status(200).json({ ok: true })
      }

      if (forget) {
        await stopToy().catch(() => {})
        await saveToy({ allowed: false, toys: {}, utoken: '', connectedAt: 0 })
        return res.status(200).json({ ok: true })
      }

      return res.status(400).json({ error: 'Nothing to do.' })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
