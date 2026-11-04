import { checkAuth, getDreams, addDream, getVows, setJSON, KEYS } from './_lib.js'
import { listForScreen, addPlan, updatePlan, removePlan, addDate, updateDate, removeDate, addMilestone, updateMilestone, removeMilestone } from './_plans.js'
import { getAllVows, saveHerVows, writeHisVows } from './_vows.js'

// Sarah's Dream Record and Vows.
// GET  → { dreams, vows }
// POST → { addDream }, { updateDream: {id, ...} }, { removeDream: id }, { vows: "text" }
export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    // Plans & special dates (Dates 📅 tab)
    if (req.method === 'GET' && req.query?.dates === '1') return res.status(200).json(await listForScreen())
    if (req.method === 'POST' && req.body?.dates) {
      const d = req.body.dates
      if (d.addPlan) await addPlan({ ...d.addPlan, by: 'sarah' })
      if (d.updatePlan?.id) await updatePlan(d.updatePlan)
      if (d.removePlan) await removePlan(d.removePlan)
      if (d.addDate) await addDate({ ...d.addDate, by: 'sarah' })
      if (d.updateDate?.id) await updateDate(d.updateDate)
      if (d.removeDate) await removeDate(d.removeDate)
      if (d.addMilestone) await addMilestone({ ...d.addMilestone, by: 'sarah' })
      if (d.updateMilestone?.id) await updateMilestone(d.updateMilestone)
      if (d.removeMilestone) await removeMilestone(d.removeMilestone)
      return res.status(200).json({ ok: true, ...(await listForScreen()) })
    }

    if (req.method === 'GET') {
      const [dreams, vows] = await Promise.all([getDreams(), getAllVows()])
      return res.status(200).json({ dreams: [...dreams].reverse(), vows })
    }

    if (req.method === 'POST') {
      const { addDream: add, updateDream, removeDream, vows, hisVows } = req.body || {}
      // Ask him to write (or rewrite) his vows in reply to hers
      if (hisVows === true) return res.status(200).json({ ok: true, vows: await writeHisVows() })

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

      // Only Sarah can write her vows — this is the only place they're saved. Then he writes his in reply.
      if (typeof vows === 'string') {
        const saved = await saveHerVows(vows)
        if (!saved.changed) return res.status(200).json({ ok: true, vows: saved.vows })
        try { return res.status(200).json({ ok: true, vows: await writeHisVows() }) } catch (err) {
          return res.status(200).json({ ok: true, vows: saved.vows, hisError: err.message })
        }
      }

      return res.status(400).json({ error: 'Nothing to do.' })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
