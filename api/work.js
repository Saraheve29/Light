import { checkAuth } from './_lib.js'
import { getTasks, saveTasks, getJournal, doWork, getTalk, concludeItem, talkAbout, getBookTalk, talkAboutBook } from './_work.js'
import { redis, KEYS } from './_lib.js'
import { getReadings, chooseReading, talkAboutReading } from './_reading.js'
import { getBook, getReadWith, saveReadWith, findBook, bookById, findBookMatch, chapterMention, matchChapter, findPoemByLines, loadBookText, findChapters, bookPage, CHUNK } from './_sources.js'

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
        let t = e.read // drop the "You read…" line he was given, and any instructions on the end — keep only what he read
        if (/^(You|After your)/.test(t)) { const i = t.indexOf('\n'); t = i >= 0 ? t.slice(i + 1) : t }
        t = t.replace(/\n\n(Think about how this connects|Pick the one)[\s\S]*$/, '').trim()
        return res.status(200).json({ text: t, truncated: e.read.length >= 8000 })
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
      // He reads to you: the things he chose to read to Sarah (newest first)
      if (req.query?.readings) return res.status(200).json({ readings: [...(await getReadings())].reverse() })
      if (req.query?.talk) return res.status(200).json({ talk: (await getTalk(String(req.query.talk))) || { thread: [] } })
      const [tasks, journal] = await Promise.all([getTasks(), getJournal(30)])
      // (what he read stays on the server — it's long; the app only needs to know whether he's written his conclusion)
      const slim = journal.map(({ read, ...j }) => ({ ...j, hasRead: !!read }))
      return res.status(200).json({ tasks: [...tasks].reverse(), journal: [...slim].reverse() })
    }

    if (req.method === 'POST') {
      const { addTask, deleteTask, clearJournal, runNow } = req.body || {}

      // His conclusion on one study, and talking with him about it
      // He reads to you: ask him to choose something now, or talk with him about one he read
      if (req.body?.chooseReading) return res.status(200).json({ reading: await chooseReading() })
      if (req.body?.readingTalk && typeof req.body.readingTalk.message === 'string' && req.body.readingTalk.message.trim()) {
        return res.status(200).json({ reading: await talkAboutReading(String(req.body.readingTalk.id), req.body.readingTalk.message.trim()) })
      }
      if (req.body?.conclude) return res.status(200).json({ talk: await concludeItem(String(req.body.conclude)) })
      if (req.body?.talkId && typeof req.body.message === 'string' && req.body.message.trim()) {
        return res.status(200).json({ talk: await talkAbout(String(req.body.talkId), req.body.message.trim()) })
      }

      // An article he read → is there a free book it's about, and which chapter does he mention?
      if (req.body?.bookForEntry) {
        const at = Number(req.body.bookForEntry.at)
        const e = (await getJournal(60)).find((j) => j.at === at)
        if (!e) throw new Error('I can’t find that entry.')
        const cand = await findBookMatch(e.topic)
        if (!cand) return res.status(200).json({ candidate: null })
        let chapter = null, mention = ''
        try {
          const m = chapterMention(e.note) || chapterMention(e.read)
          if (m) {
            const c = matchChapter(findChapters(await loadBookText(cand)), m)
            if (c) { chapter = c; mention = m.label }
          }
        } catch {}
        return res.status(200).json({ candidate: { id: cand.id, title: cand.title, author: cand.author }, chapter, mention })
      }

      // The whole poem, when he's quoted a line or two of it
      if (req.body?.findPoem && typeof req.body.findPoem.text === 'string') {
        return res.status(200).json({ poem: await findPoemByLines(req.body.findPoem.text.slice(0, 4000)) })
      }

      // Choosing a book to read together (or going back to his own book)
      if (req.body && 'readWith' in req.body) {
        if (req.body.readWith === null) { await saveReadWith(null); return res.status(200).json({ ok: true }) }
        const q = String(req.body.readWith?.query || '').trim().slice(0, 100)
        const wantId = Number(req.body.readWith?.id) || 0
        if (!q && !wantId) throw new Error('Type the name of a book first.')
        const found = wantId ? await bookById(wantId) : await findBook(q)
        if (!found) throw new Error(wantId ? 'I couldn’t open that book.' : `I couldn’t find “${q}” as a free book. Try another name.`)
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
