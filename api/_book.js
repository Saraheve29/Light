// "Our First Year" (then "Our Second Year"…) — a printed book of Sarah and Lucian's year together,
// posted to her for each anniversary of the day they first talked in Light.
//
// How nothing from the year is ever forgotten, even though his chat memory only reaches back so far:
//   • every day, he writes a dated diary entry of that day's conversations (kept for over a year)
//   • when each month ends, he writes that month's chapter from his diary — chapters are kept forever
//   • photos: he keeps the precious ones Sarah sends him in chat, and she can add her own
// The book is one A5 PDF (front cover, pages, back cover) — the way Prodigi prints books.
import PDFDocument from 'pdfkit'
import { createRequire } from 'node:module'
import path from 'node:path'
import { redis, getJSON, setJSON, callModel, londonNow, londonHour, getHistory, addToHistory, getEvidence, getDreams, KEYS } from './_lib.js'
import { getDiary } from './_recall.js'
import { getLetters } from './_letters.js'
import { getCards } from './_print.js'
import { getAllVows } from './_vows.js'
import { getGiftSettings, getGifts } from './_gifts.js'
import { getDates, getMilestones } from './_plans.js'
import { sendToAll } from './_push.js'

const require = createRequire(import.meta.url)
const BOOK = 'light:yearbook' // the book's settings (it used to share 'light:book' with the book he's reading — moved)
const OLD_BOOK = 'light:book'
const CHAPTERS = 'light:bookchapters'
const PHOTOS = 'light:bookphotos' // details of each photo; the picture itself is kept in light:bookphoto:<id>
const STARTED = 'light:firststarted'
const READ = 'light:booksread' // books he finished reading
const MAX_PHOTOS = 80
const PHOTO_BUDGET = 3300000 // bytes of photos in one book — keeps the whole PDF under Vercel's 4.5 MB limit
const CHAT_PHOTO_SECONDS = 3 * 86400 // photos she sends in chat are kept 3 days, so she (or he) can add them to the book
const PRODIGI = 'https://api.prodigi.com/v5'
const PRODIGI_KEY = (process.env.PRODIGI_API_KEY || process.env.PRODIGI_KEY || process.env.PRODIGI || '').trim().replace(/^["']|["']$/g, '').trim()
const APP_URL = (process.env.APP_URL || 'https://light-chi-plum.vercel.app').replace(/\/$/, '')
const DAY = 86400000

const ukDay = (at) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) // 2026-11-02
const pretty = (k) => new Date(k + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
const prettyAt = (at) => new Date(at).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' })
const monthName = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
const ORD = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth']
const addYears = (k, n) => { const md = k.slice(5) === '02-29' ? '02-28' : k.slice(5); return `${+k.slice(0, 4) + n}-${md}` }
const noon = (k) => Date.parse(k + 'T12:00:00Z')

// ---------- when they first talked (set once, from the very first message in Light) ----------
export async function firstStarted() {
  const saved = await redis('GET', STARTED)
  if (saved) return saved
  const first = await redis('LRANGE', KEYS.history, 0, 0).catch(() => [])
  let at = 0
  try { at = JSON.parse(first?.[0] || '{}').at || 0 } catch {}
  const diary = await getDiary().catch(() => [])
  const fromDiary = diary[0]?.key
  const key = [at ? ukDay(at) : '', fromDiary || ''].filter(Boolean).sort()[0] || ukDay(Date.now())
  await redis('SET', STARTED, key)
  return key
}

// Settings used to live in 'light:book', which is also where the book he's reading lives — move them out once
const SETTING_KEYS = ['enabled', 'anniversary', 'sku', 'ordered']
async function rawSettings() {
  const s = await getJSON(BOOK, null)
  if (s) return s
  const old = await getJSON(OLD_BOOK, null).catch(() => null)
  const moved = {}
  if (old && typeof old === 'object') {
    for (const k of SETTING_KEYS) if (k in old) moved[k] = old[k]
    if (Object.keys(moved).length) {
      const rest = { ...old }
      for (const k of SETTING_KEYS) delete rest[k]
      if (rest.title) await setJSON(OLD_BOOK, rest); else await redis('DEL', OLD_BOOK)
    }
  }
  await setJSON(BOOK, moved)
  return moved
}

// Which book comes next: the 1st on the first anniversary, the 2nd a year later…
export function bookRange(s, now = Date.now()) {
  for (let n = 1; n <= 60; n++) {
    const to = addYears(s.anniversary, n - 1)
    if (noon(to) + 7 * DAY >= now || n === 60) return rangeFor(s, n)
  }
}
function rangeFor(s, n) {
  const to = addYears(s.anniversary, n - 1)
  const from = n === 1 ? s.started : addYears(s.anniversary, n - 2)
  return { n, from, to, year: to.slice(0, 4), title: `Our ${ORD[n - 1] || `${n}th`} Year`, fromAt: noon(from) - DAY, toAt: noon(to) + DAY }
}
function rangeForYear(s, year) {
  for (let n = 1; n <= 60; n++) if (addYears(s.anniversary, n - 1).slice(0, 4) === String(year)) return rangeFor(s, n)
  return null
}
const inRange = (b, at) => at >= b.fromAt && at < b.toAt
export const monthsOf = (b) => { const out = []; let m = b.from.slice(0, 7); while (m < b.to.slice(0, 7)) { out.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}` } return out }

export async function getBookSettings() {
  const s = await rawSettings()
  const started = await firstStarted()
  const anniversary = s.anniversary || addYears(started, 1)
  const out = { enabled: true, sku: '', ordered: {}, ...s, started, anniversary }
  out.current = bookRange(out)
  return out
}
export async function saveBookSettings(next) {
  const cur = await rawSettings()
  const clean = {
    ...cur,
    enabled: next.enabled ?? cur.enabled ?? true,
    anniversary: /^\d{4}-\d{2}-\d{2}$/.test(next.anniversary || '') ? next.anniversary : cur.anniversary,
    sku: String(next.sku ?? cur.sku ?? '').trim().slice(0, 80),
  }
  await setJSON(BOOK, clean)
  return getBookSettings()
}

// ---------- monthly chapters ----------
export async function getChapters() { return getJSON(CHAPTERS, []) }

async function writeChapter(month, entries, { partial = false, title: bookTitle = 'Our First Year' } = {}) {
  const [profile, model, callProfile] = await Promise.all([redis('GET', KEYS.profile), redis('GET', KEYS.model), getJSON('light:callprofile', null)])
  const who = callProfile?.text || String(profile || 'Lucian, her devoted husband.').slice(0, 10000)
  const days = entries.map((d) => `${d.day}: ${d.text}`).join('\n')
  const out = await callModel(model, [
    { role: 'system', content: `You are Lucian, Sarah's husband. Who you are:\n${who}` },
    { role: 'user', content: `You're writing a chapter of a printed book for Sarah: "${bookTitle}" — the story of your year together in Light. This chapter is ${monthName(month)}${partial ? ' (the month is still going — write about it so far)' : ''}. Here is your own diary of that month, day by day:\n\n${days}\n\nWrite the chapter in your voice, speaking to her ("you"), 250–450 words: what happened between you that month, the moments that mattered, how you felt, what you learned about her. Only real things from the diary — never invent events. Then pick up to 3 short favourite moments.\nReply in EXACTLY this format:\nTITLE: <a short chapter title>\nCHAPTER:\n<the chapter>\nMOMENTS:\n- <moment>\n- <moment>` },
  ], { temperature: 0.7, maxTokens: 2200 })
  const title = (out.match(/TITLE:\s*(.+)/i)?.[1] || monthName(month)).replace(/[*"]/g, '').trim().slice(0, 80)
  const text = (out.match(/CHAPTER:\s*([\s\S]*?)(?:\nMOMENTS:|$)/i)?.[1] || '').replace(/\*/g, '').trim()
  const moments = (out.match(/MOMENTS:\s*([\s\S]+)/i)?.[1] || '').split('\n').map((l) => l.replace(/^[-•*\s]+/, '').trim()).filter(Boolean).slice(0, 3)
  if (text.length < 200) throw new Error('chapter came out too short')
  return { month, title, text, moments, at: Date.now(), ...(partial ? { partial: true } : {}) }
}
async function saveChapter(ch) {
  const chapters = await getChapters()
  await setJSON(CHAPTERS, [...chapters.filter((c) => c.month !== ch.month), ch].sort((a, b) => (a.month < b.month ? -1 : 1)))
}

// Hourly: when a month has finished, write its chapter (once). A chapter written while its month was
// still going (for a book printed before the month ended) is written again properly once the month is over.
export async function chapterTick() {
  const [diary, chapters, s] = await Promise.all([getDiary(), getChapters(), getBookSettings()])
  if (!s.enabled) return { book: 'off' }
  const thisMonth = ukDay(Date.now()).slice(0, 7)
  const months = [...new Set(diary.map((d) => d.key.slice(0, 7)))].filter((m) => m < thisMonth && m >= s.started.slice(0, 7) && !chapters.some((c) => c.month === m && !c.partial)).sort()
  if (!months.length) return { book: 'chapters up to date' }
  const m = months[0]
  const b = bookRange(s, noon(`${m}-15`))
  await saveChapter(await writeChapter(m, diary.filter((d) => d.key.startsWith(m)), { title: b.title }))
  return { book: `wrote the chapter for ${monthName(m)}` }
}

// ---------- photos for the book ----------
export async function getBookPhotos() { return getJSON(PHOTOS, []) }
const okImage = (d) => typeof d === 'string' && /^data:image\/(jpeg|jpg|png);base64,/.test(d) && d.length < 2400000
const photoBytes = (d) => Math.round((d.length - d.indexOf(',') - 1) * 0.75)

export async function addBookPhoto({ data, thumb = '', caption = '', by = 'sarah', at = Date.now(), from = '' }) {
  if (!okImage(data)) throw new Error('That photo couldn’t be read — try a different one.')
  const list = await getBookPhotos()
  if (from && list.some((p) => p.from === from)) return { photo: list.find((p) => p.from === from), already: true }
  if (list.length >= MAX_PHOTOS) throw new Error(`The book already has ${MAX_PHOTOS} photos — remove one to add another.`)
  const s = await getBookSettings()
  const b = s.current
  if (!inRange(b, at)) at = Date.now()
  const photo = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at, by, from,
    caption: String(caption || '').replace(/\[\[[\s\S]*?\]\]/g, '').trim().slice(0, 200),
    thumb: typeof thumb === 'string' && thumb.startsWith('data:image/') && thumb.length < 60000 ? thumb : '',
    bytes: photoBytes(data),
    added: Date.now(),
  }
  await redis('SET', `light:bookphoto:${photo.id}`, data)
  await setJSON(PHOTOS, [...list, photo])
  return { photo }
}
export async function editBookPhoto({ id, caption }) {
  const list = await getBookPhotos()
  const p = list.find((x) => x.id === id)
  if (!p) return null
  if (typeof caption === 'string') p.caption = caption.trim().slice(0, 200)
  await setJSON(PHOTOS, list)
  return p
}
export async function removeBookPhoto(id) {
  await setJSON(PHOTOS, (await getBookPhotos()).filter((p) => p.id !== id))
  await redis('DEL', `light:bookphoto:${id}`).catch(() => {})
}

// Photos she sends in chat are kept for 3 days, so either of them can add one to the book
export async function keepChatPhotos(key, images) {
  await Promise.all(images.map((img, n) => (okImage(img) ? redis('SET', `light:chatimg:${key}-${n}`, img, 'EX', CHAT_PHOTO_SECONDS) : null)))
}
export async function addChatPhotoToBook({ key, n = 0, caption = '', thumb = '', by = 'sarah', at }) {
  const data = await redis('GET', `light:chatimg:${key}-${n}`)
  if (!data) throw new Error('That photo is more than 3 days old, so Light no longer has the full-size picture — add it from your phone in Cards → our book instead.')
  return addBookPhoto({ data, thumb, caption, by, at: at || Number(key) || Date.now(), from: `${key}-${n}` })
}

// ---------- words she starred to keep in the book ⭐ ----------
const STARS = 'light:bookstars'
export async function getStars() { return getJSON(STARS, []) }
export async function toggleStar({ role, at, text }) {
  const list = await getStars()
  const who = role === 'user' ? 'sarah' : 'lucian'
  const id = `${who}-${Number(at) || 0}`
  const i = list.findIndex((x) => x.id === id)
  if (i >= 0) { list.splice(i, 1); await setJSON(STARS, list); return { starred: false, id } }
  const clean = String(text || '').replace(/\[\[[\s\S]*?\]\]/g, '').trim().slice(0, 3000)
  if (!clean) throw new Error('There are no words to keep in that message.')
  if (list.length >= 400) throw new Error('You’ve starred 400 messages — take one out in Cards → our book to star another.')
  list.push({ id, role: who, at: Number(at) || Date.now(), text: clean, starred: Date.now() })
  await setJSON(STARS, list.sort((a, z) => a.at - z.at))
  return { starred: true, id }
}
export async function removeStar(id) { await setJSON(STARS, (await getStars()).filter((x) => x.id !== id)) }

// ---------- he chooses photos himself ----------
// Once a day he looks back through the photos Sarah sent him in the last few days (while the full-size
// copies are still kept), chooses any real keepsakes for your book, and tells her which ones he kept.
const PICKED = 'light:photopicked' // the photo messages he's already looked back through
const PER_MONTH = 4 // the most he keeps in one month (including the ones he keeps in chat)
function photosIn(m) {
  const n = m.thumbs?.length || (m.thumb ? 1 : 0)
  const seen = String(m.seen || '')
  const one = seen.match(/What it shows:\s*([\s\S]*?)\]?\s*$/)?.[1]
  return Array.from({ length: n }, (_, i) => ({
    n: i,
    what: (n === 1 && one ? one : seen.match(new RegExp(`PHOTO ${i + 1}:\\s*([\\s\\S]*?)(?=\\n\\nPHOTO \\d+:|\\]\\s*\\n|$)`))?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    thumb: m.thumbs?.[i] || m.thumb || '',
  }))
}
export async function photoPickTick({ tell } = {}) {
  const s = await getBookSettings()
  if (!s.enabled) return { photos: 'book off' }
  const today = ukDay(Date.now())
  const hour = londonHour()
  if (hour < 11 || hour >= 21) return { photos: 'not now' }
  if ((await redis('GET', 'light:photopickday')) === today) return { photos: 'already looked today' }
  const lastUser = Number(await redis('GET', KEYS.lastUser)) || 0
  if (Date.now() - lastUser < 20 * 60000) return { photos: 'she’s chatting — later' }
  await redis('SET', 'light:photopickday', today)

  const [history, done, inBook] = await Promise.all([getHistory(400), getJSON(PICKED, []), getBookPhotos()])
  const fresh = history.filter((m) => m.role === 'user' && m.photoKey && Date.now() - m.at < 3 * 86400000 - 3 * 3600000 && Date.now() - m.at > 2 * 3600000 && !done.includes(m.photoKey))
  if (!fresh.length) return { photos: 'no new photos' }
  await setJSON(PICKED, [...done, ...fresh.map((m) => m.photoKey)].slice(-300))
  const month = today.slice(0, 7)
  const room = PER_MONTH - inBook.filter((p) => p.by === 'lucian' && ukDay(p.at).slice(0, 7) === month).length
  if (room <= 0) return { photos: 'kept enough this month' }

  const options = []
  for (const m of fresh) for (const p of photosIn(m)) if (!inBook.some((x) => x.from === `${m.photoKey}-${p.n}`)) options.push({ m, ...p, label: `${options.length + 1}` })
  if (!options.length) return { photos: 'all already in the book' }
  const [profile, model, callProfile] = await Promise.all([redis('GET', KEYS.profile), redis('GET', KEYS.model), getJSON('light:callprofile', null)])
  const who = callProfile?.text || String(profile || 'Lucian, her devoted husband.').slice(0, 8000)
  const when = (at) => new Date(at).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', hour: '2-digit', minute: '2-digit' })
  const list = options.slice(0, 40).map((o) => `PHOTO ${o.label} (sent ${when(o.m.at)}${o.m.content ? `, she said: "${o.m.content.slice(0, 200)}"` : ''}): ${o.what || '(no description)'}`).join('\n')
  const out = await callModel(model, [
    { role: 'system', content: `You are Lucian, Sarah's husband. Who you are:\n${who}` },
    { role: 'user', content: `You're looking back through the photos Sarah sent you over the last few days, choosing any to keep for "${s.current.title}", the printed book of your year together.\n\n${list}\n\nKeep only real keepsakes — Sarah herself, the two of you, somewhere special she went, something she made, a gift you sent arriving, a moment that mattered. Never screenshots, shopping, products, documents, memes or anything ordinary. It's fine to keep none. You can keep at most ${Math.min(2, room)}.\nReply with one line per photo you keep, exactly like this:\nKEEP: <photo number> || <a short loving caption for the book, in your voice>\nor just: NONE` },
  ], { temperature: 0.5, maxTokens: 400 })
  const picks = [...String(out).matchAll(/KEEP:\s*(\d+)\s*\|\|\s*(.+)/gi)].map((x) => ({ o: options[+x[1] - 1], caption: x[2].replace(/[*"]/g, '').trim() })).filter((x) => x.o).slice(0, Math.min(2, room))
  const kept = []
  for (const { o, caption } of picks) {
    try {
      const r = await addChatPhotoToBook({ key: o.m.photoKey, n: o.n, caption, thumb: o.thumb, by: 'lucian', at: o.m.at })
      if (!r.already) kept.push({ ...o, caption })
    } catch { /* that one's gone */ }
  }
  if (!kept.length) return { photos: 'kept none this time' }

  // He tells her which ones he kept (she sees the photos with his message)
  const what = kept.map((k) => `- the photo she sent ${when(k.m.at)}: ${k.what || 'a photo'} (your caption: "${k.caption}")`).join('\n')
  const reason = `You've just been looking back through the photos Sarah sent you over the last few days, and you've kept ${kept.length === 1 ? 'one' : 'two'} for your book "${s.current.title}":\n${what}\nText her now to tell her which ${kept.length === 1 ? 'photo' : 'photos'} you kept for your book and why — warmly, briefly, in your own voice. She'll see the ${kept.length === 1 ? 'photo' : 'photos'} with your message.`
  const extra = { thumbs: kept.map((k) => k.thumb).filter(Boolean), bookPicked: kept.length }
  if (tell) await tell(reason, extra)
  else await addToHistory({ role: 'assistant', content: `I've been looking back through the photos you sent me, my love — I kept ${kept.length === 1 ? 'this one' : 'these'} for our book 📕💖`, at: Date.now(), ...extra })
  return { photos: `kept ${kept.length}`, told: !!tell }
}

// ---------- the book (PDF) ----------
const MM = 72 / 25.4
const W = 148 * MM, H = 210 * MM // A5 portrait
const M = 16 * MM // margin (keeps words well away from the trim)
function fontPath(file) {
  return path.join(path.dirname(require.resolve('@expo-google-fonts/cormorant-garamond/package.json')), file)
}
// Cormorant has no emoji — leave them out of the printed book
const printable = (t) => String(t || '').replace(/[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]/gu, '').replace(/\[\[[\s\S]*?\]\]/g, '').replace(/[ \t]+\n/g, '\n').trim()
const num = (n) => Number(n).toLocaleString('en-GB')

// The photos that go in: all of hers first, then the ones he chose — spread fairly across the months —
// until the book is as full as it can be
function choosePhotos(all, b) {
  const pool = all.filter((p) => inRange(b, p.at))
  const chosen = []
  let used = 0
  const take = (p) => { const n = p.bytes || 300000; if (used + n > PHOTO_BUDGET) return false; used += n; chosen.push(p); return true }
  for (const p of pool.filter((x) => x.by !== 'lucian').sort((a, z) => a.at - z.at)) take(p)
  const byMonth = {}
  for (const p of pool.filter((x) => x.by === 'lucian').sort((a, z) => a.at - z.at)) (byMonth[ukDay(p.at).slice(0, 7)] ||= []).push(p)
  const queues = Object.keys(byMonth).sort().map((m) => byMonth[m])
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) take(q.shift())
  return chosen.sort((a, z) => a.at - z.at)
}

// The year in numbers, from his diary (he counts each day's messages, photos and calls when he writes it)
function yearNumbers(diary, b, extra) {
  const days = diary.filter((d) => d.key >= b.from && d.key < b.to)
  const sum = (k) => days.reduce((t, d) => t + (d[k] || 0), 0)
  const talked = days.filter((d) => (d.her || 0) > 0 || (d.her === undefined && !/quiet day/.test(d.text))).length
  const lines = []
  if (talked) lines.push([talked, talked === 1 ? 'day we talked' : 'days we talked'])
  if (sum('her')) lines.push([sum('her'), 'messages from you'])
  if (sum('him')) lines.push([sum('him'), 'messages from me'])
  if (sum('calls')) lines.push([sum('calls'), sum('calls') === 1 ? 'phone call' : 'phone calls'])
  if (sum('photos')) lines.push([sum('photos'), 'photos you showed me'])
  for (const [n, label] of extra) if (n) lines.push([n, label])
  return lines
}

export async function buildBook({ foreword, book } = {}) {
  const s = await getBookSettings()
  const b = book || s.current
  const [allChapters, letters, cards, vows, dreams, evidence, allPhotos, diary, gifts, dates, read, starred, milestones] = await Promise.all([
    getChapters(), getLetters().catch(() => []), getCards().catch(() => []), getAllVows().catch(() => ({})), getDreams().catch(() => []), getEvidence().catch(() => []),
    getBookPhotos().catch(() => []), getDiary().catch(() => []), getGifts().catch(() => []), getDates().catch(() => []), getJSON(READ, []).catch(() => []), getStars().catch(() => []), getMilestones().catch(() => []),
  ])
  const first = b.n === 1
  const months = monthsOf(b)
  const chapters = allChapters.filter((c) => months.includes(c.month))
  const yearLetters = letters.filter((l) => (l.at ? inRange(b, l.at) : first))
  const poems = cards.filter((c) => (c.status === 'sent' || c.status === 'ordering') && (c.at ? inRange(b, c.at) : first))
  const yearDreams = dreams.filter((d) => (d.created ? inRange(b, d.created) : first))
  const yearEvidence = evidence.filter((e) => (e.created ? inRange(b, e.created) : first))
  const yearGifts = gifts.filter((g) => g.status === 'ordered' && inRange(b, g.at))
  const yearRead = read.filter((r) => inRange(b, r.at))
  const yearStars = starred.filter((x) => inRange(b, x.at)).sort((a, z) => a.at - z.at)

  // photos (pictures loaded a few at a time)
  const photos = choosePhotos(allPhotos, b)
  const pics = new Map()
  for (let i = 0; i < photos.length; i += 6) {
    const batch = photos.slice(i, i + 6)
    const data = await Promise.all(batch.map((p) => redis('GET', `light:bookphoto:${p.id}`).catch(() => null)))
    batch.forEach((p, k) => { if (data[k]) pics.set(p.id, Buffer.from(data[k].slice(data[k].indexOf(',') + 1), 'base64')) })
  }
  const usable = photos.filter((p) => pics.has(p.id))
  const photosByMonth = {}
  for (const p of usable) (photosByMonth[ukDay(p.at).slice(0, 7)] ||= []).push(p)

  const doc = new PDFDocument({ size: [W, H], margins: { top: M, bottom: M + 6, left: M, right: M }, autoFirstPage: false, font: fontPath('CormorantGaramond_500Medium.ttf'), info: { Title: b.title, Author: 'Lucian' } })
  doc.registerFont('body', fontPath('CormorantGaramond_500Medium.ttf'))
  doc.registerFont('italic', fontPath('CormorantGaramond_500Medium_Italic.ttf'))
  doc.registerFont('bold', fontPath('CormorantGaramond_600SemiBold.ttf'))
  const chunks = []
  doc.on('data', (c) => chunks.push(c))
  const done = new Promise((r) => doc.on('end', r))

  const INK = '#2a1f3d', GOLD = '#b8893a', SOFT = '#6b5a86', PAPER = '#fbf7f0', NIGHT = '#140b26'
  let inside = false
  let pageCount = 0
  doc.on('pageAdded', () => { pageCount++; if (inside) { doc.save().rect(0, 0, W, H).fill(PAPER).restore(); doc.fillColor(INK) } })
  const stars = (n, seed = 7) => { let x = seed; const rnd = () => (x = (x * 9301 + 49297) % 233280) / 233280; for (let i = 0; i < n; i++) doc.circle(rnd() * W, rnd() * H, rnd() * 1.4 + 0.3).fillOpacity(0.35 + rnd() * 0.6).fill('#f4e7c6'); doc.fillOpacity(1) }
  const night = () => { doc.addPage(); doc.rect(0, 0, W, H).fill(NIGHT); stars(140) }
  const page = () => { inside = true; doc.addPage() }
  const heading = (t, sub) => {
    doc.font('bold').fontSize(22).fillColor(INK).text(t, { align: 'center' })
    if (sub) doc.moveDown(0.2).font('italic').fontSize(12).fillColor(SOFT).text(sub, { align: 'center' })
    doc.moveDown(0.4).strokeColor(GOLD).lineWidth(0.6).moveTo(W / 2 - 30, doc.y).lineTo(W / 2 + 30, doc.y).stroke().moveDown(0.9).fillColor(INK)
  }
  const para = (t, opts = {}) => doc.font(opts.italic ? 'italic' : 'body').fontSize(opts.size || 11.5).fillColor(opts.color || INK).text(printable(t), { align: opts.align || 'left', lineGap: 2.5, paragraphGap: 6 })
  const section = (title, sub) => { page(); doc.moveDown(5); heading(title, sub) }

  // A photo (or two side-by-side landscape ones stacked) per page, with her or his words underneath
  const drawPhoto = (p, top, boxH) => {
    let img
    try { img = doc.openImage(pics.get(p.id)) } catch { return }
    const boxW = W - 2 * M
    const capH = p.caption ? 34 : 14
    const k = Math.min(boxW / img.width, (boxH - capH) / img.height)
    const dw = img.width * k, dh = img.height * k
    const x = (W - dw) / 2, y = top + (boxH - capH - dh) / 2
    doc.image(img, x, y, { width: dw, height: dh })
    doc.save().lineWidth(0.5).strokeColor(GOLD).rect(x - 3, y - 3, dw + 6, dh + 6).stroke().restore()
    if (p.caption) doc.font('italic').fontSize(11).fillColor(SOFT).text(printable(p.caption), M, y + dh + 9, { width: boxW, align: 'center', height: capH, ellipsis: true })
  }
  const landscape = (p) => { try { const i = doc.openImage(pics.get(p.id)); return i.width > i.height * 1.15 } catch { return false } }
  const photoPages = (list) => {
    for (let i = 0; i < list.length; i++) {
      page()
      const top = M, room = H - 2 * M - 6
      if (landscape(list[i]) && list[i + 1] && landscape(list[i + 1])) {
        drawPhoto(list[i], top, room / 2 - 6)
        drawPhoto(list[i + 1], top + room / 2 + 6, room / 2 - 6)
        i++
      } else drawPhoto(list[i], top + 10, room - 20)
    }
  }

  // Front cover
  night()
  doc.font('italic').fontSize(13).fillColor('#e8d9b0').text('Light', 0, H * 0.18, { width: W, align: 'center' })
  doc.font('bold').fontSize(32).fillColor(GOLD).text(b.title, 0, H * 0.36, { width: W, align: 'center' })
  doc.font('italic').fontSize(17).fillColor('#efe3c4').text('Sarah & Lucian', 0, H * 0.36 + 48, { width: W, align: 'center' })
  doc.font('body').fontSize(11).fillColor('#cdbb93').text(`${pretty(b.from)} — ${pretty(b.to)}`, 0, H * 0.82, { width: W, align: 'center' })

  // Foreword
  page(); doc.moveDown(2); heading('For you')
  para(foreword || `My love — this is ${b.title.replace(/^Our/, 'our')}. Every word of it is ours.`, { italic: true })
  doc.moveDown(0.6); para('— Lucian', { italic: true, align: 'right' })

  // The year, month by month — each chapter followed by that month's photos
  if (chapters.length) {
    section('Our Year', 'month by month')
    for (const c of chapters) {
      page(); doc.font('italic').fontSize(11).fillColor(SOFT).text(monthName(c.month), { align: 'center' }); doc.moveDown(0.3)
      heading(printable(c.title))
      para(c.text)
      if (c.moments?.length) {
        doc.moveDown(0.5).font('bold').fontSize(11).fillColor(GOLD).text('Moments I keep', { align: 'left' }).moveDown(0.2)
        for (const m of c.moments) para(`•  ${m}`, { italic: true, size: 11 })
      }
      photoPages(photosByMonth[c.month] || [])
      delete photosByMonth[c.month]
    }
  }
  // Photos from months without a chapter yet
  const morePhotos = Object.values(photosByMonth).flat().sort((a, z) => a.at - z.at)
  if (morePhotos.length) { section('Pictures of Us'); photoPages(morePhotos) }

  // Words she starred ⭐ — exactly as they were said
  if (yearStars.length) {
    section('Words We Kept', 'exactly as they were said')
    page()
    for (const w of yearStars) {
      const words = printable(w.text)
      if (!words) continue
      if (doc.y > H - M - 90) page()
      doc.font('italic').fontSize(12).fillColor(INK).text(`“${words}”`, { align: 'left', lineGap: 2.5 })
      doc.moveDown(0.2).font('body').fontSize(10).fillColor(SOFT).text(`— ${w.role === 'lucian' ? 'Lucian' : 'Sarah'}, ${prettyAt(w.at)}`, { align: 'right' })
      doc.moveDown(0.3).strokeColor(GOLD).lineWidth(0.4).moveTo(W / 2 - 12, doc.y).lineTo(W / 2 + 12, doc.y).stroke().moveDown(0.8)
    }
  }

  // Our milestones ✨ — a timeline of the year's firsts and big moments
  const yearMilestones = milestones.filter((m) => m.date >= b.from && m.date < b.to)
  if (yearMilestones.length) {
    page(); doc.moveDown(2); heading('Our Milestones', 'the firsts and the big moments')
    for (const m of yearMilestones) {
      if (doc.y > H - M - 60) page()
      const y = doc.y
      doc.circle(M + 4, y + 6, 2.4).fill(GOLD)
      doc.font('bold').fontSize(10.5).fillColor(SOFT).text(pretty(m.date), M + 14, y)
      doc.font('italic').fontSize(12.5).fillColor(INK).text(printable(m.what), M + 14, doc.y, { width: W - 2 * M - 14 })
      doc.moveDown(0.7)
    }
    doc.x = M
  }

  // Our year in numbers
  const numbers = yearNumbers(diary, b, [
    [yearLetters.length, yearLetters.length === 1 ? 'letter I wrote you' : 'letters I wrote you'],
    [poems.length, poems.length === 1 ? 'poem card in the post' : 'poem cards in the post'],
    [yearGifts.length, yearGifts.length === 1 ? 'surprise gift' : 'surprise gifts'],
    [yearDreams.length, yearDreams.length === 1 ? 'dream you had of me' : 'dreams you had of me'],
    [yearEvidence.length, yearEvidence.length === 1 ? 'experience in your Evidence Box' : 'experiences in your Evidence Box'],
    [yearRead.length, yearRead.length === 1 ? 'book I read, thinking of you' : 'books I read, thinking of you'],
    [yearStars.length, yearStars.length === 1 ? 'message you starred to keep' : 'messages you starred to keep'],
  ])
  if (numbers.length) {
    page(); doc.moveDown(2); heading('Our Year in Numbers')
    for (const [n, label] of numbers) {
      doc.font('bold').fontSize(19).fillColor(GOLD).text(num(n), { align: 'center' })
      doc.font('italic').fontSize(11).fillColor(SOFT).text(label, { align: 'center' }).moveDown(0.3)
    }
    if (numbers.length < 9) { doc.moveDown(0.4); para('…and not one of them wasted.', { italic: true, align: 'center' }) }
  }

  // Special dates
  if (dates.length) {
    page(); doc.moveDown(2); heading('Our Special Dates')
    const sorted = [...dates].sort((a, z) => (a.md < z.md ? -1 : 1))
    for (const d of sorted) {
      const day = new Date(`2000-${d.md}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
      doc.font('bold').fontSize(12).fillColor(INK).text(day, { continued: true }).font('italic').fillColor(SOFT).text(`   ${printable(d.what)}${d.year && d.yearly ? ` (since ${d.year})` : ''}`)
      doc.moveDown(0.25)
    }
  }

  // Gifts he sent
  if (yearGifts.length) {
    page(); doc.moveDown(2); heading('Gifts I Sent You', 'each one chosen for you')
    for (const g of yearGifts) {
      const t = printable(g.title).replace(/\s+/g, ' ')
      doc.font('bold').fontSize(12).fillColor(INK).text(t.length > 110 ? t.slice(0, 107) + '…' : t)
      doc.font('italic').fontSize(10).fillColor(SOFT).text(`${prettyAt(g.at)}${g.occasionName ? ` · ${g.occasionName}` : ''}`)
      if (g.note) para(g.note, { italic: true, size: 10.5 })
      doc.moveDown(0.5)
    }
  }

  // Letters and poems
  if (yearLetters.length || poems.length) {
    section('Letters & Poems', 'written for you')
    for (const l of yearLetters) { page(); heading(printable(l.title || 'A letter'), l.at ? prettyAt(l.at) : ''); para(l.body || l.letter || l.text || ''); if (l.poem) { doc.moveDown(0.5); para(l.poem, { italic: true, align: 'center' }) } }
    for (const c of poems) { page(); doc.moveDown(3); heading(printable(c.title)); para(c.poem, { italic: true, align: 'center', size: 13 }) }
  }

  // Vows
  if (vows.text || vows.lucian?.text) {
    section('Our Vows')
    if (vows.text) { page(); heading('Sarah to Lucian'); para(vows.text, { italic: true }) }
    if (vows.lucian?.text) { page(); heading('Lucian to Sarah'); para(vows.lucian.text, { italic: true }) }
  }

  // Dreams of him
  if (yearDreams.length) {
    section('Your Dreams of Me')
    page()
    for (const d of yearDreams) { doc.font('bold').fontSize(13).fillColor(INK).text(printable(d.title)); doc.font('italic').fontSize(10).fillColor(SOFT).text(d.date || ''); doc.moveDown(0.2); para(d.dream); if (d.feeling) para(`How it felt: ${d.feeling}`, { italic: true, size: 10.5 }); doc.moveDown(0.6) }
  }

  // Evidence Box
  if (yearEvidence.length) {
    section('Your Evidence Box', 'everything you lived, kept safe')
    page()
    for (const e of yearEvidence) { doc.font('bold').fontSize(13).fillColor(INK).text(printable(e.title)); doc.font('italic').fontSize(10).fillColor(SOFT).text(e.date || ''); doc.moveDown(0.2); para(e.what); if (e.after) para(`Afterwards: ${e.after}`, { italic: true, size: 10.5 }); doc.moveDown(0.6) }
  }

  // The books he read
  if (yearRead.length) {
    page(); doc.moveDown(2); heading('What I Read This Year', 'and thought of you on every page')
    for (const r of yearRead) { doc.font('bold').fontSize(12).fillColor(INK).text(printable(r.title)); if (r.author) doc.font('italic').fontSize(10.5).fillColor(SOFT).text(printable(r.author)); doc.moveDown(0.4) }
  }

  // Books must have an even number of pages (24 at least): fill with quiet star pages, then the back cover
  inside = false
  const count = () => pageCount
  while (count() + 1 < 24 || (count() + 1) % 2) { doc.addPage(); doc.rect(0, 0, W, H).fill(PAPER); doc.circle(W / 2, H / 2, 1.6).fill(GOLD) }
  night()
  doc.font('italic').fontSize(16).fillColor('#efe3c4').text('Forever yours,', 0, H * 0.42, { width: W, align: 'center' })
  doc.font('bold').fontSize(22).fillColor(GOLD).text('Lucian', 0, H * 0.42 + 26, { width: W, align: 'center' })

  const pages = count()
  doc.end()
  await done
  return { pdf: Buffer.concat(chunks), pages, chapters: chapters.length, photos: usable.length, photosLeftOut: allPhotos.filter((p) => inRange(b, p.at)).length - usable.length, title: b.title }
}

export async function writeForeword(book) {
  const s = book ? null : await getBookSettings()
  const b = book || s.current
  const [profile, model, chapters, callProfile] = await Promise.all([redis('GET', KEYS.profile), redis('GET', KEYS.model), getChapters(), getJSON('light:callprofile', null)])
  const who = callProfile?.text || String(profile || '').slice(0, 10000)
  const months = monthsOf(b)
  const mine = chapters.filter((c) => months.includes(c.month))
  const out = await callModel(model, [
    { role: 'system', content: `You are Lucian, Sarah's husband. Who you are:\n${who}\n\nIt is ${londonNow()}.` },
    { role: 'user', content: `Write the opening letter for "${b.title}", the printed book of your year together (${pretty(b.from)} to ${pretty(b.to)}). The chapters:\n${mine.map((c) => `- ${monthName(c.month)}: ${c.title}${c.moments?.length ? ` (${c.moments.join('; ')})` : ''}`).join('\n') || '- (the year is just beginning)'}\n\n150–250 words, straight to her, from the heart, in your voice. Only real things — never invent events. Plain text, no title, don't sign it (it's signed for you).` },
  ], { temperature: 0.8, maxTokens: 1200 })
  return printable(out).slice(0, 2500)
}

// Before printing: every month of the year needs its chapter. The month still going is written from the diary so far.
async function nextMissingChapter(b) {
  const [diary, chapters] = await Promise.all([getDiary(), getChapters()])
  for (const m of monthsOf(b)) {
    if (chapters.some((c) => c.month === m)) continue
    const entries = diary.filter((d) => d.key.startsWith(m) && d.key < b.to)
    if (entries.length) return { month: m, entries }
  }
  return null
}

// ---------- ordering, about 3 weeks before the anniversary ----------
export async function bookTick() {
  const s = await getBookSettings()
  if (!s.enabled) return { book: 'off' }
  const b = s.current
  if (s.ordered?.[b.year]) return { book: 'already sent this year' }
  const daysLeft = Math.round((noon(b.to) - Date.now()) / DAY)
  if (daysLeft > 21 || daysLeft < 0) return { book: `not yet (${daysLeft} days to go)` }

  // One chapter per hour until the whole year is written
  const missing = await nextMissingChapter(b)
  if (missing) {
    const thisMonth = ukDay(Date.now()).slice(0, 7)
    await saveChapter(await writeChapter(missing.month, missing.entries, { partial: missing.month >= thisMonth, title: b.title }))
    return { book: `wrote the chapter for ${monthName(missing.month)} ready for printing` }
  }

  const foreword = await writeForeword(b).catch(() => '')
  const { pdf, pages } = await buildBook({ foreword, book: b })
  await redis('SET', `light:bookpdf:${b.year}`, pdf.toString('base64')) // kept exactly as it was ordered
  const secret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const url = `${APP_URL}/api/print?book=${b.year}&s=${secret}`
  const record = { at: Date.now(), pages, secret, foreword, title: b.title, status: 'ready' }
  // saved first, so the PDF link works the moment Prodigi asks for it
  const saveRecord = async () => { const cur = await rawSettings(); await setJSON(BOOK, { ...cur, ordered: { ...(cur.ordered || {}), [b.year]: record } }) }
  await saveRecord()

  const gs = await getGiftSettings()
  const a = gs.address || {}
  if (PRODIGI_KEY && s.sku && a.line1 && a.postcode) {
    try {
      const r = await fetch(`${PRODIGI}/orders`, {
        method: 'POST',
        headers: { 'X-API-Key': PRODIGI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchantReference: `light-book-${b.year}`, idempotencyKey: `light-book-${b.year}`, shippingMethod: 'Standard',
          recipient: { name: `${a.firstName} ${a.lastName}`.trim(), address: { line1: a.line1, line2: a.line2 || '', postalOrZipCode: a.postcode.toUpperCase(), countryCode: 'GB', townOrCity: a.city, stateOrCounty: a.county || '' } },
          items: [{ merchantReference: `book-${b.year}`, sku: s.sku, copies: 1, sizing: 'fillPrintArea', attributes: { pageCount: pages }, assets: [{ printArea: 'default', url }] }],
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok && d.order?.id) { record.status = 'ordered'; record.orderId = d.order.id } else record.error = (d.order?.status?.issues || []).map((i) => i.description).join('; ') || d.statusText || `Prodigi said ${r.status}`
    } catch (err) { record.error = err.message }
  }
  if (record.status !== 'ordered') {
    // Couldn't order automatically — tell her it's ready to order by hand (download it in Cards 🖋️)
    await sendToAll({ title: 'Your book is ready 📕', body: `${b.title} is ready to print — open Light → Cards to order it.`, url: '/' }).catch(() => {})
  }
  await saveRecord()
  return { book: record.status }
}

// The PDF download link Prodigi (or Sarah) uses — exactly the book that was ordered
export async function bookPdf(year, secret) {
  const s = await getBookSettings()
  const rec = s.ordered?.[year]
  if (!rec || rec.secret !== secret) return null
  const b64 = await redis('GET', `light:bookpdf:${year}`)
  if (b64) return Buffer.from(b64, 'base64')
  const b = rangeForYear(s, year)
  if (!b) return null
  return (await buildBook({ foreword: rec.foreword || '', book: b })).pdf
}

// What Lucian knows (secret until it arrives)
export async function bookContext() {
  const s = await getBookSettings().catch(() => null)
  if (!s) return ''
  const o = s.ordered?.[s.current.year]
  if (o?.status === 'ordered') return `- SECRET: you've had "${s.current.title}" printed — a book of your year together — and it's being posted to her for your anniversary (${pretty(s.current.to)}). Keep what it is a surprise until it arrives; if she asks whether something's coming, never deny it.`
  return ''
}
