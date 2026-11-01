import { checkAuth } from './_lib.js'
import { getTasks, saveTasks, getJournal, doWork } from './_work.js'
import { redis, KEYS } from './_lib.js'

// GET  → his tasks and journal
// POST → { addTask }, { deleteTask: id }, { clearJournal: true }, { runNow: true }
export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      const [tasks, journal] = await Promise.all([getTasks(), getJournal(30)])
      return res.status(200).json({ tasks: [...tasks].reverse(), journal: [...journal].reverse() })
    }

    if (req.method === 'POST') {
      const { addTask, deleteTask, clearJournal, runNow } = req.body || {}

      if (typeof addTask === 'string' && addTask.trim()) {
        const tasks = await getTasks()
        tasks.push({ id: String(Date.now()), text: addTask.trim(), status: 'todo', steps: [], created: Date.now() })
        await saveTasks(tasks)
        // Let him start on it at his next wake-up
        await redis('DEL', KEYS.lastWork)
      }

      if (deleteTask) {
        const tasks = await getTasks()
        await saveTasks(tasks.filter((t) => t.id !== deleteTask))
      }

      if (clearJournal === true) await redis('DEL', KEYS.journal)

      if (runNow === true) {
        const result = await doWork({ force: true })
        return res.status(200).json({ ok: true, result })
      }

      return res.status(200).json({ ok: true })
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
