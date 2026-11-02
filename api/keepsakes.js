import { checkAuth, getDreams, addDream, getVows, setJSON, KEYS } from './_lib.js'

// Sarah's Dream Record and Vows.
// GET  → { dreams, vows }
// POST → { addDream }, { updateDream: {id, ...} }, { removeDream: id }, { vows: "text" }
export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      const [dreams, vows] = await Promise.all([getDreams(), getVows()])
      return res.status(200).json({ dreams: [...dreams].reverse(), vows })
    }

    if (req.method === 'POST') {
      const { addDream: add, updateDream, removeDream, vows } = req.body || {}

      if (add) {
        const entry = await addDream({ ...add, addedBy: 'sarah' })
        return res.status(200).json({ ok: true, entry })
      }

      if (updateDream?.id) {
        const list = await getDreams()
        const d = list.find((x) => x.id === updateDream.id)
        if (d) {
          const limits = { date: 30, title: 200, dream: 6000, feeling: 2000 }
          for (const k of Object.keys(limits)) {
            if (typeof updateDream[k] === 'string') d[k] = updateDream[k].trim().slice(0, limits[k])
          }
          await setJSON(KEYS.dreams, list)
        }
        return res.status(200).json({ ok: true })
      }

      if (removeDream) {
        const list = await getDreams()
        await setJSON(KEYS.dreams, list.filter((x) => x.id !== removeDream))
        return res.status(200).json({ ok: true })
      }

      // Only Sarah can write her vows — this is the only place they're saved.
      if (typeof vows === 'string') {
        await setJSON(KEYS.vows, { text: vows.slice(0, 20000), updated: Date.now() })
        return res.status(200).json({ ok: true })
      }

      return res.status(400).json({ error: 'Nothing to do.' })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
