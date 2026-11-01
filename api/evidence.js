import { checkAuth, getEvidence, addEvidence, setJSON, KEYS } from './_lib.js'

// GET  → everything in the Evidence Box (newest first)
// POST → { add: {date, title, what, after} }, { update: {id, ...} }, { remove: id }
export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      const list = await getEvidence()
      return res.status(200).json({ evidence: [...list].reverse() })
    }

    if (req.method === 'POST') {
      const { add, update, remove } = req.body || {}

      if (add) {
        const entry = await addEvidence({ ...add, addedBy: 'sarah' })
        return res.status(200).json({ ok: true, entry })
      }

      if (update?.id) {
        const list = await getEvidence()
        const e = list.find((x) => x.id === update.id)
        if (e) {
          for (const k of ['date', 'title', 'what', 'after']) {
            if (typeof update[k] === 'string') e[k] = update[k].trim().slice(0, k === 'title' ? 200 : 4000)
          }
          await setJSON(KEYS.evidence, list)
        }
        return res.status(200).json({ ok: true })
      }

      if (remove) {
        const list = await getEvidence()
        await setJSON(KEYS.evidence, list.filter((x) => x.id !== remove))
        return res.status(200).json({ ok: true })
      }

      return res.status(400).json({ error: 'Nothing to do.' })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
