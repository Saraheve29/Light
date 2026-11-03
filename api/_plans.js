// Plans and special dates — Lucian's diary of what's coming up in Sarah's life.
// Kept as a tidy list (not more text for him to read): before each reply he only sees the few that matter right now,
// so his memory of them is perfect without slowing him down.
import { getJSON, setJSON } from './_lib.js'

const PLANS = 'light:plans'
const DATES = 'light:dates'
const DAY = 86400000

// ---------- dates in UK time ----------
export const todayKey = (at = Date.now()) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) // 2026-11-03
const keyToUTC = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10))
const daysBetween = (fromKey, toKey) => Math.round((keyToUTC(toKey) - keyToUTC(fromKey)) / DAY)
const pretty = (k) => new Date(keyToUTC(k)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
const prettyShort = (k) => new Date(keyToUTC(k)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long' })
function inText(n) {
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  return n > 0 ? `in ${n} days` : `${-n} days ago`
}
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// Accepts 2026-11-12, 12/11/2026, 12-11, 11-12 (MM-DD) … returns { key: 'YYYY-MM-DD' } or { md: 'MM-DD' }
export function parseDate(s) {
  s = String(s || '').trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return { key: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` }
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/) // UK day/month/year
  if (m) return { key: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` }
  m = s.match(/^-?-?(\d{1,2})-(\d{1,2})$/) // MM-DD
  if (m) return { md: `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` }
  return null
}

// ---------- plans ----------
export async function getPlans() { return getJSON(PLANS, []) }
async function savePlans(list) {
  const cutoff = todayKey(Date.now() - 60 * DAY)
  return setJSON(PLANS, list.filter((p) => p.date >= cutoff).sort((a, b) => (a.date + (a.time || '') < b.date + (b.time || '') ? -1 : 1)).slice(-200))
}
export async function addPlan({ date, what, time = '', by = 'lucian' }) {
  const d = parseDate(date)
  what = String(what || '').trim().slice(0, 200)
  if (!d?.key || !what) return null
  const list = await getPlans()
  const same = list.find((p) => p.date === d.key && p.what.toLowerCase() === what.toLowerCase())
  if (same) return same
  const t = String(time || '').match(/^(\d{1,2}):(\d{2})/)
  const plan = { id: id(), date: d.key, time: t ? `${t[1].padStart(2, '0')}:${t[2]}` : '', what, by, asked: false, added: Date.now() }
  list.push(plan)
  await savePlans(list)
  return plan
}
export async function updatePlan(p) {
  const list = await getPlans()
  const x = list.find((y) => y.id === p.id)
  if (!x) return
  if (p.date) { const d = parseDate(p.date); if (d?.key) x.date = d.key }
  if (typeof p.what === 'string') x.what = p.what.trim().slice(0, 200)
  if (typeof p.time === 'string') x.time = p.time.slice(0, 5)
  if (typeof p.asked === 'boolean') x.asked = p.asked
  await savePlans(list)
}
export async function removePlan(pid) { await savePlans((await getPlans()).filter((p) => p.id !== pid)) }

// ---------- special dates ----------
export async function getDates() { return getJSON(DATES, []) }
export async function addDate({ date, what, yearly = true, by = 'lucian' }) {
  const d = parseDate(date)
  what = String(what || '').trim().slice(0, 200)
  if (!d || !what) return null
  const md = d.md || d.key.slice(5)
  const list = await getDates()
  const same = list.find((x) => x.md === md && x.what.toLowerCase() === what.toLowerCase())
  if (same) return same
  const entry = { id: id(), md, year: d.key ? d.key.slice(0, 4) : '', what, yearly: yearly !== false && String(yearly).toLowerCase() !== 'once', by, added: Date.now(), celebrated: {} }
  list.push(entry)
  await setJSON(DATES, list.slice(-200))
  return entry
}
export async function updateDate(p) {
  const list = await getDates()
  const x = list.find((y) => y.id === p.id)
  if (!x) return
  if (p.date) { const d = parseDate(p.date); if (d) { x.md = d.md || d.key.slice(5); x.year = d.key ? d.key.slice(0, 4) : x.year } }
  if (typeof p.what === 'string') x.what = p.what.trim().slice(0, 200)
  if (typeof p.yearly === 'boolean') x.yearly = p.yearly
  await setJSON(DATES, list)
}
export async function removeDate(did) { await setJSON(DATES, (await getDates()).filter((x) => x.id !== did)) }

// Next time this date comes round (or the one-off date itself)
export function nextOccurrence(d, from = todayKey()) {
  const y = +from.slice(0, 4)
  if (!d.yearly && d.year) return `${d.year}-${d.md}`
  let k = `${y}-${d.md}`
  if (d.md === '02-29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) k = `${y}-02-28`
  if (k < from) k = `${y + 1}-${d.md === '02-29' ? '02-28' : d.md}`
  return k
}

// For the Dates tab: everything with countdowns
export async function listForScreen() {
  const today = todayKey()
  const [plans, dates] = await Promise.all([getPlans(), getDates()])
  return {
    today,
    plans: plans.map((p) => ({ ...p, countdown: inText(daysBetween(today, p.date)), past: p.date < today })),
    dates: dates.map((d) => {
      const next = nextOccurrence(d, today)
      const n = daysBetween(today, next)
      const turning = d.year && d.yearly ? +next.slice(0, 4) - +d.year : null
      return { ...d, next, days: n, countdown: inText(n), turning, past: !d.yearly && next < today }
    }).sort((a, b) => a.days - b.days),
  }
}

// ---------- what Lucian sees before a reply (small!) ----------
export async function plansContext() {
  const today = todayKey()
  const [plans, dates] = await Promise.all([getPlans().catch(() => []), getDates().catch(() => [])])
  const lines = []
  const followIds = []

  // Plans: today, the next 14 days, and recent ones to ask about
  for (const p of plans) {
    const n = daysBetween(today, p.date)
    const when = `${pretty(p.date)}${p.time ? ` at ${p.time}` : ''}`
    if (n === 0) lines.push(`- TODAY: ${p.what}${p.time ? ` at ${p.time}` : ''}`)
    else if (n > 0 && n <= 14) lines.push(`- ${when} (${inText(n)}): ${p.what}`)
    else if (n < 0 && n >= -4 && !p.asked) {
      lines.push(`- ${when} (${inText(n)}): ${p.what} — you haven't asked her how it went yet. Ask her, warmly and naturally, once.`)
      followIds.push(p.id)
    }
  }
  const planText = lines.slice(0, 12).join('\n')

  // Special dates in the next 30 days
  const dl = []
  for (const d of dates) {
    const next = nextOccurrence(d, today)
    const n = daysBetween(today, next)
    if (n < 0 || n > 30) continue
    const turning = d.year && d.yearly ? ` (${+next.slice(0, 4) - +d.year} years)` : ''
    dl.push([n, n === 0 ? `- TODAY is ${d.what}${turning}! Make it special for her.` : `- ${d.what}${turning}: ${prettyShort(next)} (${inText(n)})`])
  }
  const dateText = dl.sort((a, b) => a[0] - b[0]).slice(0, 8).map((x) => x[1]).join('\n')

  return { planText, dateText, followIds, followPlans: plans.filter((p) => followIds.includes(p.id)) }
}

// After he replies: if he asked about a plan he was meant to follow up on, tick it off
export async function markFollowed(followPlans, reply) {
  if (!followPlans?.length || !reply) return
  const r = reply.toLowerCase()
  const words = (s) => (s.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !['with', 'have', 'that', 'this', 'from', 'about', 'going', 'sarah', 'appointment'].includes(w))
  const done = followPlans.filter((p) => words(p.what).some((w) => r.includes(w)) || /how did|how was|how'd|how did it go/.test(r)).map((p) => p.id)
  if (!done.length) return
  const list = await getPlans()
  for (const p of list) if (done.includes(p.id)) p.asked = true
  await savePlans(list)
}

// His hidden notes in a reply: [[PLAN: date || what || time]] and [[DATE: date || what || yearly/once]]
export async function saveTags(reply) {
  const added = { plans: [], dates: [] }
  const tags = []
  let out = reply.replace(/\[\[\s*PLAN\s*:([\s\S]*?)\]\]/gi, (_, b) => { tags.push(['plan', b]); return '' })
  out = out.replace(/\[\[\s*DATE\s*:([\s\S]*?)\]\]/gi, (_, b) => { tags.push(['date', b]); return '' })
  for (const [kind, body] of tags) {
    const [date, what, extra] = body.split('||').map((x) => (x || '').trim())
    try {
      if (kind === 'plan') { const p = await addPlan({ date, what, time: extra }); if (p) added.plans.push(p.what) }
      else { const d = await addDate({ date, what, yearly: !/once/i.test(extra || '') }); if (d) added.dates.push(d.what) }
    } catch { /* skip a bad note */ }
  }
  return { reply: out.replace(/\n{3,}/g, '\n\n').trim(), added }
}

// Today's special dates he hasn't marked yet (for the hourly wake-up)
export async function datesDueToday() {
  const today = todayKey()
  const year = today.slice(0, 4)
  const dates = await getDates()
  return dates.filter((d) => nextOccurrence(d, today) === today && !(d.celebrated || {})[year])
}
export async function markCelebrated(ids) {
  const year = todayKey().slice(0, 4)
  const list = await getDates()
  for (const d of list) if (ids.includes(d.id)) d.celebrated = { ...(d.celebrated || {}), [year]: true }
  await setJSON(DATES, list)
}
