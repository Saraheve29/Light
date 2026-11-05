import { checkAuth } from './_lib.js'
import { getToy, saveToy, getQrCode, handleCallback, stopToy, runMove, toyReady, hasDevToken, maxSecondsFor, lastReply } from './_toy.js'

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
        lan: t.lan || null,
        seen: t.seen || null,
        ready: toyReady(t),
        lastCommand: t.lastCommand,
        maxSeconds: maxSecondsFor(t),
      })
    }

    if (req.method === 'POST') {
      const { pair, allowed, stop, test, forget, maxSeconds } = req.body || {}

      if (maxSeconds != null) {
        const t = await getToy()
        t.maxSeconds = maxSecondsFor({ maxSeconds })
        await saveToy(t)
        return res.status(200).json({ ok: true, maxSeconds: t.maxSeconds })
      }

      if (stop) return res.status(200).json({ ok: true, ...((await stopToy()) || {}) })

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
        try {
          return res.status(200).json({ ok: true, ...((await runMove(move)) || {}), lovense: lastReply })
        } catch (err) { return res.status(200).json({ ok: false, error: err.message, lovense: lastReply }) }
      }

      if (forget) {
        await stopToy().catch(() => {})
        const old = await getToy()
        await saveToy({ allowed: false, toys: {}, utoken: '', connectedAt: 0, maxSeconds: old.maxSeconds })
        return res.status(200).json({ ok: true })
      }

      return res.status(400).json({ error: 'Nothing to do.' })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
