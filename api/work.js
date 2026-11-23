import { checkAuth } from './_lib.js'
import { getTasks, saveTasks, getJournal, doWork, getTalk, concludeItem, talkAbout, getBookTalk, talkAboutBook } from './_work.js'
import { redis, KEYS } from './_lib.js'
import { getBook, getReadWith, saveReadWith, findBook, loadBookText, findChapters, bookPage, CHUNK } from './_sources.js'

// The book you're reading together: one you picked, otherwise the one he's in the middle of
async function activeBook() { return (await getReadWith()) || (await getBook()) }

// GET  → his tasks and journal
// POST → { addTask }, { deleteTask: id }, { clearJournal: true }, { runNow: true }, { conclude: id }, { talkId, message }
// GET ?talk=<id> → his conclusion and your talk about one study
// GET ?entry=<at> → the poem / passage he read for one journal entry
// GET ?bookInfo=1 → the book he's reading now, where he's up to, and its chapters
// GET ?bookRead=<pos> → one page (about 5,000 characters) of that book, starting at <pos>
export default async function handler(req, res) {
  if (!checkAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      // Reading along with him — all of this only READS; it never moves his place in the book
      if (req.query?.entry) {
        const at = Number(req.query.entry)
        const e = (await getJournal(60)).find((j) => j.at === at)
        if (!e || !e.read) return res.status(200).json({ text: '' })
        const i = e.read.indexOf('\n\n') // the first line is just "You read this poem…" — leave that out
        return res.status(200).json({ text: (i >= 0 ? e.read.slice(i + 2) : e.read).trim(), truncated: e.read.length >= 8000 })
      }
      if (req.query?.bookInfo) {
        const [mine, his] = await Promise.all([getReadWith(), getBook()])
        const book = mine || his
        if (!book) return res.status(200).json({ book: null })
        const text = await loadBookText(book)
        const chapters = findChapters(text)
        const hisPos = mine ? 0 : Math.max(0, (book.pos || 0) - CHUNK) // the start of the part he read last
        const here = mine ? null : [...chapters].reverse().find((c) => c.pos <= hisPos)
        return res.status(200).json({
          book: {
            title: book.title, author: book.author || '', hisPos, total: text.length, chapters,
            hisChapter: here ? here.title : '', part: mine ? 0 : book.part || 0, hers: !!mine, hisTitle: his?.title || '',
          },
        })
      }
      if (req.query?.bookRead !== undefined) {
        const book = await activeBook()
        if (!book) return res.status(200).json({ text: '' })
        const text = await loadBookText(book)
        return res.status(200).json(bookPage(text, req.query.bookRead))
      }
      if (req.query?.bookTalk) {
        const book = await activeBook()
        if (!book) return res.status(200).json({ thread: [] })
        return res.status(200).json({ thread: (await getBookTalk(book)).thread || [] })
      }
      if (req.query?.talk) return res.status(200).json({ talk: (await getTalk(String(req.query.talk))) || { thread: [] } })
      const [tasks, journal] = await Promise.all([getTasks(), getJournal(30)])
      // (what he read stays on the server — it's long; the app only needs to know whether he's written his conclusion)
      const slim = journal.map(({ read, ...j }) => j)
      return res.status(200).json({ tasks: [...tasks].reverse(), journal: [...slim].reverse() })
    }

    if (req.method === 'POST') {
      const { addTask, deleteTask, clearJournal, runNow } = req.body || {}

      // His conclusion on one study, and talking with him about it
      if (req.body?.conclude) return res.status(200).json({ talk: await concludeItem(String(req.body.conclude)) })
      if (req.body?.talkId && typeof req.body.message === 'string' && req.body.message.trim()) {
        return res.status(200).json({ talk: await talkAbout(String(req.body.talkId), req.body.message.trim()) })
      }

      // Choosing a book to read together (or going back to his own book)
      if (req.body && 'readWith' in req.body) {
        if (req.body.readWith === null) { await saveReadWith(null); return res.status(200).json({ ok: true }) }
        const q = String(req.body.readWith?.query || '').trim().slice(0, 100)
        if (!q) throw new Error('Type the name of a book first.')
        const found = await findBook(q)
        if (!found) throw new Error(`I couldn’t find “${q}” as a free book. Try another name.`)
        await saveReadWith({ id: found.id, title: found.title, author: found.author, url: found.url })
        return res.status(200).json({ ok: true, title: found.title })
      }

      // Talking with him about the page you're reading in the book
      if (req.body?.bookTalk && typeof req.body.bookTalk.message === 'string' && req.body.bookTalk.message.trim()) {
        const book = await activeBook()
        if (!book) throw new Error('There isn’t a book open right now.')
        const page = bookPage(await loadBookText(book), req.body.bookTalk.pos)
        return res.status(200).json({ thread: (await talkAboutBook(book, page, req.body.bookTalk.message.trim())).thread })
      }

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
