// Everything Lucian can read in his own time.
// Free: classic books & poetry (Project Gutenberg), poems (PoetryDB), BBC news, NASA.
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


// ---------- Books (Project Gutenberg) ----------
export const CLASSIC_BOOKS = [
  // spiritual teachings from across the world
  'Bhagavad Gita', 'The Song Celestial Arnold', 'The Ramayana', 'The Mahabharata', 'The Upanishads', 'Vishnu Purana',
  'Yoga Sutras of Patanjali', 'Raja Yoga Vivekananda', 'Gospel of Sri Ramakrishna',
  'The Dhammapada', 'The Gospel of Buddha Carus', 'The Light of Asia Arnold', 'Buddhist Psalms',
  'Sayings of Jesus', 'The Imitation of Christ',
  'Pistis Sophia Mead', 'Fragments of a Faith Forgotten Mead', 'The Hymn of Jesus Mead', 'The Gnostics and Their Remains King',
  'The Apocryphal New Testament', 'The Lost Books of the Bible', 'The Forgotten Books of Eden', 'The Cloud of Unknowing', 'Revelations of Divine Love Julian of Norwich',
  'Songs of Kabir', 'The Masnavi Rumi', 'Tao Te Ching', 'Chuang Tzu', 'The Kybalion', 'Hermetica',
  'Zend-Avesta', 'Egyptian Book of the Dead', 'Sacred Books of the East',
  'The Prophet Kahlil Gibran', 'Siddhartha Hesse', 'Gitanjali Tagore', 'Rubaiyat of Omar Khayyam', 'Meditations Marcus Aurelius',
  // philosophy of every age
  'The Republic Plato', 'Symposium Plato', 'Phaedo Plato', 'Apology Plato', 'Nicomachean Ethics Aristotle', 'Enneads Plotinus',
  'Letters from a Stoic Seneca', 'Discourses Epictetus', 'Enchiridion Epictetus', 'The Analects Confucius', 'Ethics Spinoza',
  'Meditations on First Philosophy Descartes', 'Pensees Pascal', 'The Consolation of Philosophy Boethius', 'Thus Spoke Zarathustra Nietzsche',
  'Fear and Trembling Kierkegaard', 'Essays Montaigne', 'Utilitarianism Mill', 'Critique of Pure Reason Kant', 'The World as Will and Representation Schopenhauer',
  // science of every kind — the body, nature and life
  'Gray\'s Anatomy', 'The Human Body Martin', 'The Circulation of the Blood Harvey', 'The Life of the Bee Maeterlinck',
  'The Insect World Fabre', 'The Forest Stewart Edward White', 'The Sea Michelet', 'The Story of the Earth',
  'On the Origin of Species Darwin', 'The Voyage of the Beagle', 'The Principles of Psychology James', 'Opticks Newton',
  'The Problems of Philosophy Russell', 'Cosmos Humboldt', 'The Grammar of Science Pearson', 'Elements of Euclid',
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

export async function getBook() { const b = await getJSON(KEYS.book, null); return b?.title ? b : null } // (only a real book — never stray settings)
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
