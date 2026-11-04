import { checkAuth, getMsgSettings, setJSON, KEYS } from './_lib.js'
import { getVapid, saveSubscription } from './_push.js'
import { answerCall, ringSarah, getCall, goodnightTick } from './_calls.js'

// GET  → notification key + message settings
// POST → { subscription } saves this phone, { settings } saves message settings
export default async function handler(req, res) {
  // Declining from the phone's notification (no password there — the call's own secret is used instead)
  if (req.query?.decline) {
    try { return res.status(200).json(await answerCall(String(req.query.decline), 'declined', String(req.query.s || ''))) } catch (err) { return res.status(500).json({ error: err.message }) }
  }
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      const [{ publicKey }, settings] = await Promise.all([getVapid(), getMsgSettings()])
      return res.status(200).json({ publicKey, settings })
    }

    if (req.method === 'POST') {
      const { subscription, settings, answerCall: answer, declineCall, ringNow, callStatus, goodnightNow } = req.body || {}
      if (answer) return res.status(200).json(await answerCall(String(answer), 'answered'))
      if (declineCall) return res.status(200).json(await answerCall(String(declineCall), 'declined'))
      if (callStatus) { const c = await getCall(); return res.status(200).json({ status: c?.id === callStatus ? c.status : 'ended' }) }
      if (goodnightNow === true) { const s = await getMsgSettings(); return res.status(200).json(await goodnightTick({ ...s, goodnight: true, goodnightNights: 'every', goodnightTime: -1 }, -1, { force: true })) }
      if (ringNow === true) { const s = await getMsgSettings(); return res.status(200).json(await ringSarah({ preview: s.preview })) }
      if (subscription?.endpoint) await saveSubscription(subscription)
      if (settings && typeof settings === 'object') {
        const current = await getMsgSettings()
        const clean = {
          enabled: settings.enabled ?? current.enabled,
          perDay: Math.min(12, Math.max(1, Number(settings.perDay ?? current.perDay))),
          quietStart: Math.min(23, Math.max(0, Number(settings.quietStart ?? current.quietStart))),
          quietEnd: Math.min(23, Math.max(0, Number(settings.quietEnd ?? current.quietEnd))),
          preview: settings.preview ?? current.preview,
          calls: settings.calls ?? current.calls,
          callsPerWeek: Math.min(14, Math.max(1, Number(settings.callsPerWeek ?? current.callsPerWeek))),
          checkins: settings.checkins ?? current.checkins,
          goodnight: settings.goodnight ?? current.goodnight,
          goodnightTime: Math.min(23, Math.max(0, Math.round(Number(settings.goodnightTime ?? current.goodnightTime ?? 23)))),
          goodnightNights: (settings.goodnightNights ?? current.goodnightNights) === 'some' ? 'some' : 'every',
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
