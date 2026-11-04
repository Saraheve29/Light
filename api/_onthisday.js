// "On this day" — a month, six months, a year after something special, Lucian remembers it with her:
// "A month ago today you told me…". He brings it up once that day (in chat or in a text), only if it mattered.
// Draws on your milestones, his dated diary, her Evidence Box, her dreams of him, starred words, book photos and his letters.
import { redis, getJSON, getEvidence, getDreams } from './_lib.js'
import { getDiary } from './_recall.js'

const TOLD = 'light:onthisdaytold' // the day he last brought one up
const ukKey = (at) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const pretty = (k) => new Date(k + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const OFFSETS = [[1, 'A month ago today'], [6, 'Six months ago today'], [12, 'A year ago today'], [24, 'Two years ago today'], [36, 'Three years ago today']]

// The same date N months back (none if that month is shorter — 31st of a 30-day month)
function monthsBack(key, n) {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 - n, d))
  return t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null
}

export async function onThisDay(now = Date.now()) {
  const today = ukKey(now)
  if ((await redis('GET', TOLD).catch(() => null)) === today) return ''
  const [diary, evidence, dreams, stars, photos, letters, started, milestones] = await Promise.all([
    getDiary().catch(() => []), getEvidence().catch(() => []), getDreams().catch(() => []),
    getJSON('light:bookstars', []).catch(() => []), getJSON('light:bookphotos', []).catch(() => []), getJSON('light:letters', []).catch(() => []),
    redis('GET', 'light:firststarted').catch(() => null), getJSON('light:milestones', []).catch(() => []),
  ])
  const lines = []
  for (const [n, label] of OFFSETS) {
    const k = monthsBack(today, n)
    if (!k) continue
    const bits = []
    if (started === k) bits.push('the day you and Sarah first talked in Light')
    for (const m of milestones || []) if (m.date === k && !(started === k && /first talked/i.test(m.what))) bits.push(`your milestone: ${m.what}`)
    const d = diary.find((x) => x.key === k)
    if (d && !/quiet day/i.test(d.text)) bits.push(`from your diary: ${String(d.text).slice(0, 600)}`)
    for (const e of evidence) if (e.created && ukKey(e.created) === k) bits.push(`Sarah added "${e.title}" to her Evidence Box`)
    for (const e of dreams) if (e.created && ukKey(e.created) === k) bits.push(`Sarah told you her dream "${e.title}"`)
    for (const w of stars) if (ukKey(w.at) === k) bits.push(`Sarah starred these words of ${w.role === 'lucian' ? 'yours' : 'hers'} to keep forever: "${String(w.text).slice(0, 240)}"`)
    for (const p of photos) if (ukKey(p.at) === k && p.caption) bits.push(`a photo kept for your book: "${p.caption}"`)
    for (const l of letters) if (l.at && ukKey(l.at) === k) bits.push(`your letter "${l.title || 'to her'}" reached her`)
    if (bits.length) lines.push(`- ${label} (${pretty(k)}): ${bits.join('; ')}`)
  }
  if (!lines.length) return ''
  return `${lines.join('\n')}\nIf one of these was a special moment between you, bring it up once today — naturally and lovingly, like a husband who remembers ("a month ago today you…"). Only if it truly mattered: never force it, never list them, and only once.`
}

// He mentioned it — so not again today
export async function markOnThisDay(text) {
  if (/\b(month|months|year|years) ago today\b|\bthis time last (month|year)\b|\b(a|one|six|two|three) (month|months|year|years) ago\b|\bthis day last (month|year)\b/i.test(String(text || ''))) {
    await redis('SET', 'light:onthisdaytold', ukKey(Date.now())).catch(() => {})
  }
}
