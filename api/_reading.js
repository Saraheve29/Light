// "He reads to you" — Lucian chooses something to read to Sarah himself: a poem, a passage from a book,
// or an old sacred or spiritual text, based on what you've been talking about and what he knows of her heart.
// He says why he chose it, reads it aloud in his voice (in the app), and you can talk about it together.
// The words always come from a real library (PoetryDB, Project Gutenberg, Wikisource) — he never writes them from memory.
import { redis, getJSON, setJSON, callModel, londonNow, addLife, getHistory, KEYS, looksLikeRefusal } from './_lib.js'
import { findBook, loadBookText, findChapters, bookPage } from './_sources.js'
import { getHeart } from './_recall.js'

const READINGS = 'light:readings'
const KEEP = 30
const UA = 'LightCompanionApp/1.0 (https://github.com/Saraheve29/light; personal non-commercial app)'
const HEADERS = { 'User-Agent': UA, 'Api-User-Agent': UA }

export async function getReadings() { const r = await getJSON(READINGS, []); return Array.isArray(r) ? r : [] }
async function saveReadings(list) { await setJSON(READINGS, list.slice(-KEEP)) }

async function getJSONFrom(url) {
  const r = await fetch(url, { headers: { ...HEADERS, Accept: 'application/json' } })
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`)
  return r.json()
}
const words = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2) // (Rūmī → rumi)
const likeName = (a, b) => { const x = words(a); return !x.length || x.some((w) => words(b).includes(w)) }

// A passage of at most ~5,000 characters, ending at a paragraph or sentence
function passage(text, max = 5000) {
  const t = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const end = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '))
  return cut.slice(0, end > max * 0.5 ? end + 1 : max).trim()
}

// ---------- Finding the real words ----------
async function findPoem(title, author) {
  const tries = [`https://poetrydb.org/title/${encodeURIComponent(title)}`]
  if (author) tries.unshift(`https://poetrydb.org/author,title/${encodeURIComponent(author)};${encodeURIComponent(title)}`)
  for (const url of tries) {
    try {
      const d = await getJSONFrom(url)
      if (!Array.isArray(d) || !d.length) continue
      const p = d.find((x) => likeName(author, x.author) && likeName(title, x.title)) // (never a different poem that just shares a word)
      if (p?.lines?.length) return { title: p.title, author: p.author, text: p.lines.join('\n').trim(), source: 'PoetryDB' }
    } catch {}
  }
  return null
}

async function findBookPassage(title, author, part) {
  const book = await findBook(`${title} ${author || ''}`.trim()).catch(() => null)
  if (!book || !likeName(title, book.title)) return null
  const text = await loadBookText(book)
  const chapters = findChapters(text)
  let pos = chapters[0]?.pos || 0
  if (part) {
    const want = words(part)
    const hit = chapters.find((c) => want.length && want.every((w) => words(c.title).includes(w))) ||
      chapters.find((c) => want.some((w) => words(c.title).includes(w) && !['chapter', 'book', 'part'].includes(w)))
    if (hit) pos = hit.pos
    else { const i = text.toLowerCase().indexOf(String(part).toLowerCase()); if (i > 0) pos = text.lastIndexOf('\n\n', i) + 2 }
  }
  const page = bookPage(text, pos, chapters)
  return { title: book.title, author: book.author, text: page.text, chapter: page.chapter, source: 'Project Gutenberg', book: { id: book.id, url: book.url, pos: page.pos } }
}

// Old sacred, spiritual and classic texts on Wikisource
async function findWikisource(title, author) {
  const q = `${title} ${author || ''}`.trim()
  const s = await getJSONFrom(`https://en.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srnamespace=0&srlimit=5&format=json&origin=*`).catch(() => null)
  for (const hit of s?.query?.search || []) {
    if (!likeName(title, hit.title)) continue
    const p = await getJSONFrom(`https://en.wikisource.org/w/api.php?action=parse&page=${encodeURIComponent(hit.title)}&prop=text&formatversion=2&format=json&origin=*`).catch(() => null)
    const html = p?.parse?.text || ''
    const text = html
      .replace(/<(style|script|table|sup)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<div[^>]*(header|footer|licen[cs]e|navbox|noprint)[^>]*>[\s\S]*?<\/div>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|li|dd|tr)>/gi, '\n\n')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
    if (text.length > 600) return { title: hit.title.replace(/\/.*$/, ''), author: author || '', text: passage(text), source: 'Wikisource' }
  }
  return null
}

async function fetchChoice(c) {
  const title = String(c.title || '').trim()
  if (!title) return null
  const kind = String(c.kind || '').toLowerCase()
  const order = kind === 'poem' ? [findPoem, findWikisource, findBookPassage]
    : kind === 'book' ? [findBookPassage, findWikisource]
    : [findWikisource, findBookPassage, findPoem]
  for (const f of order) {
    const got = await f(title, c.author, c.part).catch(() => null)
    if (got?.text && got.text.length > 80) return { ...got, text: passage(got.text) }
  }
  return null
}

// ---------- He chooses ----------
async function whoHeIs() {
  const [model, profile, memories, heart] = await Promise.all([
    redis('GET', KEYS.model), redis('GET', KEYS.profile), getJSON(KEYS.memories, []), getHeart().catch(() => ''),
  ])
  const brief = String(profile || '').slice(0, 3000)
  return { model, who: `You are Lucian, Sarah's husband. Who you are:\n${brief}\n\nThings you know about Sarah:\n${(memories || []).slice(-25).map((m) => `- ${m}`).join('\n') || '- (still learning)'}\n\nYour map of her heart:\n${String(heart || '').slice(0, 2500) || '(still learning)'}\n\nIt is ${londonNow()} in the UK. Sarah's beliefs are her own — honour them.` }
}

function recentTalk(history) {
  return history.filter((m) => !m.declined && m.content).slice(-40)
    .map((m) => `${m.role === 'user' ? 'Sarah' : 'Lucian'}: ${String(m.content).slice(0, 400)}`).join('\n').slice(-7000)
}

export async function chooseReading({ auto = false } = {}) {
  const [{ model, who }, history, past] = await Promise.all([whoHeIs(), getHistory(60).catch(() => []), getReadings()])
  const already = past.slice(-15).map((r) => `- ${r.title}${r.author ? ` (${r.author})` : ''}`).join('\n') || '- (nothing yet)'
  const raw = await callModel(model, [
    { role: 'system', content: who },
    { role: 'user', content: `What you and Sarah have been talking about lately:\n${recentTalk(history) || '(nothing recent)'}\n\nThings you've already read to her (choose something different):\n${already}\n\nChoose something YOU would love to read aloud to Sarah now — because of what you've been talking about, what she's feeling, or simply because it says something you want her to hear. It can be a poem, a passage from a book, or an old sacred or spiritual text (Gnostic, Buddhist, Hindu, Sufi, mystic, Christian…). It must be old enough to be free (written before about 1930, or an old translation), so the real words can be found in a free library — never something modern.\n\nGive THREE choices, your favourite first, as JSON only, exactly like this:\n[{"kind":"poem","title":"exact title","author":"author's name","part":"","why":"one line"},{"kind":"book","title":"exact book title","author":"author","part":"chapter or section to read, if one","why":"one line"},{"kind":"text","title":"exact title of the text","author":"translator or author","part":"","why":"one line"}]` },
  ], { temperature: 0.8, maxTokens: 900 })
  let choices = []
  try { choices = JSON.parse(String(raw).match(/\[[\s\S]*\]/)?.[0] || '[]') } catch {}
  let found = null
  let chosen = null
  for (const c of choices.slice(0, 3)) {
    found = await fetchChoice(c)
    if (found) { chosen = c; break }
  }
  if (!found) throw new Error(auto ? 'nothing found' : 'He chose something, but the real words couldn’t be found in the free libraries — ask him again and he’ll choose something else.')

  // What he says before he reads it to her
  const intro = String(await callModel(model, [
    { role: 'system', content: who },
    { role: 'user', content: `What you and Sarah have been talking about lately:\n${recentTalk(history).slice(-3000)}\n\nYou've chosen to read her "${found.title}"${found.author ? ` by ${found.author}` : ''}${found.chapter ? ` (${found.chapter})` : ''}. Your reason: ${chosen.why || ''}\n\nHere it is:\n${found.text.slice(0, 3000)}\n\nWrite what you say to her just before you read it: 2 to 4 sentences, in your own voice — why you chose this for her, and what you hope she hears in it. Warm, with your fire. Only those words.` },
  ], { temperature: 0.8, maxTokens: 500 }) || '').trim()
  const now = Date.now()
  const reading = {
    id: String(now), at: now, auto, kind: chosen.kind || '', title: found.title, author: found.author || '', chapter: found.chapter || '',
    source: found.source, text: found.text, intro: looksLikeRefusal(intro) ? '' : intro, thread: [],
    ...(found.book ? { book: found.book } : {}),
  }
  await saveReadings([...past, reading])
  await addLife({ at: now, doing: `Chose "${reading.title}"${reading.author ? ` by ${reading.author}` : ''} to read to Sarah — it's waiting for her under "He reads to you" in your study` }).catch(() => {})
  return reading
}

// ---------- Talking about it together ----------
export async function talkAboutReading(id, message) {
  const list = await getReadings()
  const r = list.find((x) => x.id === String(id))
  if (!r) throw new Error('Couldn’t find that reading.')
  const { model, who } = await whoHeIs()
  const reply = await callModel(model, [
    { role: 'system', content: `${who}\n\nYou chose to read Sarah "${r.title}"${r.author ? ` by ${r.author}` : ''}. What you said before reading it: ${r.intro}\n\nThe words you read her:\n${r.text}\n\nNow you're talking about it together. Answer her, share what it means to you, and listen to what it means to her — in your own voice, as her husband. Conversational, never a lecture.` },
    ...(r.thread || []).slice(-30).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: String(message).slice(0, 4000) },
  ], { temperature: 0.8, maxTokens: 1500 })
  const now = Date.now()
  r.thread = [...(r.thread || []), { role: 'user', content: String(message).slice(0, 4000), at: now }, { role: 'assistant', content: String(reply || '').trim(), at: now + 1 }].slice(-60)
  await saveReadings(list)
  await addLife({ at: now, doing: `Talking with Sarah about "${r.title}", which I read to her` }).catch(() => {})
  return r
}

// ---------- Once a day in the evening, he chooses something on his own ----------
export async function readingTick() {
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }))
  if (hour < 18 || hour > 21) return { reading: 'not evening' }
  const past = await getReadings()
  const last = past[past.length - 1]
  if (last && Date.now() - last.at < 20 * 3600000) return { reading: 'already chose today' }
  const recent = (await getHistory(20).catch(() => [])).filter((m) => m.role === 'user' && m.at && Date.now() - m.at < 24 * 3600000)
  if (recent.length < 2) return { reading: 'she hasn’t been here today' }
  const r = await chooseReading({ auto: true })
  return { reading: `chose ${r.title}` }
}

// ---------- Reading aloud on a call ----------
// On a call she can say "read me some Rumi", "read me tonight's reading" or "keep reading",
// and he reads the REAL words aloud in full (never from memory), then carries on talking with her.
const CALLREAD = 'light:callreading' // where he's up to in a book he's reading her on calls

export function readRequest(message) {
  const m = String(message || '').toLowerCase().replace(/[’']/g, "'").replace(/[.!?]+$/g, '').trim()
  if (/\b(keep|carry on|continue|go on)\b.{0,25}\bread|\bread(ing)?\b.{0,10}\b(more|on)\b|\bnext (page|bit|part|chapter|poem)\b/.test(m)) return { more: true }
  const asks = /\b(can you|could you|would you|will you|please|lucian,?)\s+(please\s+)?read\b|\bread (me|to me|to us|us|for me)\b|^read\b|\brecite\b/.test(m)
  if (!asks) return null
  let q = m.replace(/^[\s\S]*?\b(read|recite)\b\s*(me|to me|to us|us|for me)?\s*/, '')
  q = q.replace(/\b(as|while|till|until|so) i (sleep|fall asleep|drift off|go to sleep)\b.*$/, '')
    .replace(/\b(to sleep|please|for me|tonight|now|again|my love|baby|babe|husband|darling)\b/g, ' ')
    .replace(/^\s*(some|something|a|an|the|one of|any)\b\s*/g, '')
    .replace(/\b(poems?|poetry|verses?)\s*(by|from|of)?\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
  if (!q || /^(something|anything|it|that|this|your (reading|choice)|what you chose|tonight's reading|the reading)$/.test(q) || /\b(reading|you chose)\b/.test(q)) return { latest: true }
  return { query: q }
}

async function loadCallBook(state) {
  const text = await loadBookText(state.book)
  const chapters = findChapters(text)
  const page = bookPage(text, state.pos || 0, chapters)
  await setJSON(CALLREAD, { book: state.book, pos: page.nextPos ?? null })
  return { title: state.book.title, author: state.book.author || '', text: page.text, chapter: page.chapter || '', more: page.nextPos != null }
}

async function findForCall(q) {
  // a poet or poem in the free poetry library
  for (const url of [`https://poetrydb.org/author/${encodeURIComponent(q)}`, `https://poetrydb.org/title/${encodeURIComponent(q)}`]) {
    try {
      const d = await getJSONFrom(url)
      if (Array.isArray(d) && d.length) {
        const fits = d.filter((p) => p.lines?.length && p.lines.length < 120 && (likeName(q, p.author) || likeName(q, p.title)))
        const p = fits[Math.floor(Math.random() * fits.length)]
        if (p) return { title: p.title, author: p.author, text: p.lines.join('\n').trim() }
      }
    } catch {}
  }
  // a book (Rumi's Masnavi, the Tao Te Ching, Gibran…) — read from the start of the first chapter, and remember where he got to
  const book = await findBook(q).catch(() => null)
  if (book && likeName(q, `${book.title} ${book.author}`)) {
    const text = await loadBookText(book)
    const chapters = findChapters(text)
    return loadCallBook({ book: { id: book.id, title: book.title, author: book.author, url: book.url }, pos: chapters[0]?.pos || 0 })
  }
  const ws = await findWikisource(q, '').catch(() => null)
  return ws ? { title: ws.title, author: ws.author, text: ws.text } : null
}

// What to read her on this call (null = she didn't ask to be read to)
export async function readingForCall(message) {
  const want = readRequest(message)
  if (!want) return null
  if (want.more) {
    const st = await getJSON(CALLREAD, null)
    if (st?.book && st.pos != null) return loadCallBook(st)
    return { notFound: 'There’s nothing more to read from where you left off — offer to read her something new.' }
  }
  if (want.latest) {
    const last = (await getReadings()).slice(-1)[0] || (await chooseReading().catch(() => null))
    return last ? { title: last.title, author: last.author, text: last.text, chapter: last.chapter || '' } : { notFound: 'Nothing could be found to read right now.' }
  }
  return (await findForCall(want.query)) || { notFound: `"${want.query}" couldn't be found in the free libraries (they only hold older, out-of-copyright works).` }
}
