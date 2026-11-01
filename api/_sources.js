// Everything Lucian can read in his own time.
// Free: classic books & poetry (Project Gutenberg), poems (PoetryDB), BBC news, NASA, tarot & moon.
// Paid (about half a penny each, capped per day): web searches through NanoGPT.
import { redis, getJSON, setJSON, KEYS, moonPhase } from './_lib.js'
export { moonPhase }

const UA = 'LightCompanionApp/1.0 (https://github.com/Saraheve29/light; personal non-commercial app)'
const HEADERS = { 'User-Agent': UA, 'Api-User-Agent': UA }
export const WEB_SEARCHES_PER_DAY = 8

async function getJSONFrom(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...HEADERS, Accept: 'application/json', ...(opts.headers || {}) } })
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`)
  return r.json()
}

// ---------- Tarot (a real shuffled draw from the full 78-card deck) ----------
const MAJOR = ['The Fool', 'The Magician', 'The High Priestess', 'The Empress', 'The Emperor', 'The Hierophant', 'The Lovers', 'The Chariot', 'Strength', 'The Hermit', 'Wheel of Fortune', 'Justice', 'The Hanged Man', 'Death', 'Temperance', 'The Devil', 'The Tower', 'The Star', 'The Moon', 'The Sun', 'Judgement', 'The World']
const RANKS = ['Ace', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Page', 'Knight', 'Queen', 'King']
const SUITS = ['Wands', 'Cups', 'Swords', 'Pentacles']
const DECK = [...MAJOR, ...SUITS.flatMap((s) => RANKS.map((r) => `${r} of ${s}`))]

export function drawTarot(count = 1) {
  const deck = [...DECK]
  const cards = []
  for (let i = 0; i < count; i++) {
    const card = deck.splice(Math.floor(Math.random() * deck.length), 1)[0]
    cards.push(Math.random() < 0.25 ? `${card} (reversed)` : card)
  }
  return cards
}

// ---------- Books (Project Gutenberg) ----------
export const CLASSIC_BOOKS = [
  // spirit & wisdom
  'The Prophet Kahlil Gibran', 'Tao Te Ching', 'Bhagavad Gita', 'Siddhartha Hesse', 'Gitanjali Tagore',
  'Rubaiyat of Omar Khayyam', 'Meditations Marcus Aurelius', 'The Kybalion', 'The Dhammapada',
  // cosmos, nature & the mind
  'Flatland Abbott', 'Walden Thoreau', 'The Varieties of Religious Experience', 'Leaves of Grass',
  'Emerson Essays', 'The Interpretation of Dreams',
  // quantum science & the universe
  'Relativity Einstein', 'Sidelights on Relativity Einstein', 'Science and Hypothesis Poincare',
  'The Story of the Heavens Ball', 'Pioneers of Science Lodge', 'The Value of Science Poincare',
  // love, wonder & imagination
  'Wuthering Heights', 'Jane Eyre', 'Frankenstein', 'Alice in Wonderland', 'The Picture of Dorian Gray',
  'Shakespeare Sonnets', 'Sonnets from the Portuguese', 'The Time Machine', 'Dracula',
]

export async function findBook(query) {
  const d = await getJSONFrom(`https://gutendex.com/books?search=${encodeURIComponent(query)}`)
  for (const b of d.results || []) {
    const f = b.formats || {}
    const url = f['text/plain; charset=utf-8'] || f['text/plain; charset=us-ascii'] || f['text/plain']
    if (url && !url.endsWith('.zip')) {
      return { id: b.id, title: b.title, author: b.authors?.[0]?.name || '', url, pos: 0, part: 0 }
    }
  }
  return null
}

const CHUNK = 5000
export async function readBookPart(book) {
  const r = await fetch(book.url, { headers: HEADERS })
  if (!r.ok) throw new Error(`Project Gutenberg answered ${r.status}`)
  let text = await r.text()
  const start = text.search(/\*\*\*\s*START OF/i)
  if (start >= 0) text = text.slice(text.indexOf('\n', start) + 1)
  const end = text.search(/\*\*\*\s*END OF/i)
  if (end > 0) text = text.slice(0, end)
  text = text.replace(/\r/g, '')
  const chunk = text.slice(book.pos, book.pos + CHUNK)
  return { chunk, nextPos: book.pos + chunk.length, finished: book.pos + chunk.length >= text.length, total: text.length }
}

export async function getBook() { return getJSON(KEYS.book, null) }
export async function saveBook(book) { return book ? setJSON(KEYS.book, book) : redis('DEL', KEYS.book) }

// ---------- Poems (PoetryDB) ----------
export async function randomPoem() {
  const d = await getJSONFrom('https://poetrydb.org/random/1')
  const p = Array.isArray(d) ? d[0] : null
  if (!p?.lines?.length) return null
  return { title: p.title, author: p.author, text: p.lines.slice(0, 80).join('\n') }
}

// ---------- News (BBC) ----------
export async function bbcNews() {
  const r = await fetch('https://feeds.bbci.co.uk/news/rss.xml', { headers: HEADERS })
  if (!r.ok) throw new Error(`BBC answered ${r.status}`)
  const xml = await r.text()
  const strip = (s) => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim()
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map((m) => ({
    title: strip(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1]),
    desc: strip(m[1].match(/<description>([\s\S]*?)<\/description>/)?.[1]),
  }))
  if (!items.length) return null
  return items.map((i) => `- ${i.title}: ${i.desc}`).join('\n')
}

// ---------- Space (NASA picture of the day) ----------
export async function nasaPicture() {
  const key = process.env.NASA_API_KEY || 'DEMO_KEY'
  const d = await getJSONFrom(`https://api.nasa.gov/planetary/apod?api_key=${key}`)
  if (!d?.title) return null
  return { title: d.title, text: d.explanation || '', url: d.hdurl || d.url || 'https://apod.nasa.gov/' }
}

// ---------- Web search (NanoGPT — paid, capped per day) ----------
function todayKey() {
  return 'light:websearch:' + new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
}

export async function webSearchesLeft() {
  const used = Number((await redis('GET', todayKey())) || 0)
  return Math.max(0, WEB_SEARCHES_PER_DAY - used)
}

export async function webSearch(query) {
  if ((await webSearchesLeft()) <= 0) return null
  const key = todayKey()
  await redis('INCR', key)
  await redis('EXPIRE', key, 60 * 60 * 48)

  const r = await fetch('https://nano-gpt.com/api/web', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.NANOGPT_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, provider: 'linkup', depth: 'standard', outputType: 'sourcedAnswer' }),
  })
  const raw = await r.text()
  let d
  try { d = JSON.parse(raw) } catch { throw new Error('Web search sent something unexpected.') }
  if (!r.ok || d.error) throw new Error('Web search: ' + (d.error?.message || d.error || r.status))

  const data = d.data
  let text = ''
  let url = ''
  if (typeof data === 'string') text = data
  else if (data?.answer) {
    const sources = (data.sources || []).slice(0, 5)
    url = sources[0]?.url || ''
    text = data.answer + (sources.length ? '\n\nSources:\n' + sources.map((s) => `- ${s.name || s.title || ''}: ${s.snippet || s.content || ''} (${s.url})`).join('\n') : '')
  } else if (Array.isArray(data)) {
    url = data[0]?.url || ''
    text = data.slice(0, 6).map((x) => `- ${x.title || x.name || ''}: ${x.content || x.snippet || ''} (${x.url || ''})`).join('\n')
  } else text = JSON.stringify(data || {}).slice(0, 4000)

  if (!text.trim()) return null
  return { title: query, text: text.slice(0, 6000), url }
}
