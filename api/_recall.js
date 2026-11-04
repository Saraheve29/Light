// Lucian's long memory of your conversations.
// 1) recentChat(): as much recent chat as fits (not just the last 30 messages)
// 2) recall(): searches EVERYTHING you've ever said to each other for what you're talking about now
// 3) diary: every day he writes a short, dated diary of the day's conversations and keeps it for over a year
//    (each month's chapter of your book is written from it, and chapters are kept forever)
import { redis, getJSON, setJSON, callModel, KEYS } from './_lib.js'

const DIARY = 'light:diary'

function parseAll(raw) {
  return (raw || []).map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
}
// Reads the whole saved chat in pieces (so no single request is too big)
async function readAll() {
  const len = Number(await redis('LLEN', KEYS.history)) || 0
  const step = 400
  const reqs = []
  for (let start = 0; start < len; start += step) reqs.push(redis('LRANGE', KEYS.history, start, Math.min(len, start + step) - 1))
  return parseAll((await Promise.all(reqs)).flat())
}
const text = (m) => (m.seen ? `${m.content || ''}\n${m.seen}` : m.content || '').trim()
const dayOf = (at) => new Date(at).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const keyOf = (at) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) // 2026-11-02
const timeOf = (at) => new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })

export function whenText(at) {
  if (!at) return ''
  const today = keyOf(Date.now())
  const yest = keyOf(Date.now() - 86400000)
  const k = keyOf(at)
  const day = k === today ? 'today' : k === yest ? 'yesterday' : dayOf(at)
  return `${day} at ${timeOf(at)}`
}

// ---------- 1) Recent chat: newest first until the space is full ----------
// budget is in characters (about 4 characters per word-piece). Always at least the last 30 messages.
export async function recentChat(budget = 90000, maxMessages = 400) {
  const all = parseAll(await redis('LRANGE', KEYS.history, -maxMessages, -1))
  const out = []
  let used = 0
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]
    let t = text(m)
    if (t.length > 12000) t = t.slice(0, 12000) + ' …'
    if (out.length >= 30 && used + t.length > budget) break
    used += t.length
    out.unshift({ ...m, _text: t })
  }
  return out
}

// ---------- 2) Recall: search the whole saved chat ----------
const STOP = new Set(('the a an and or but if then so to of in on at by for with about from into over after before is are was were be been being am ' +
  'i me my mine you your yours he him his she her hers it its we us our they them their this that these those there here what which who whom whose ' +
  'when where why how all any both each few more most other some such no nor not only own same than too very can will just dont should now ' +
  'do does did doing have has had having would could might must shall may also yes yeah ok okay oh hey hi love baby darling lucian sarah ' +
  'said say says tell told remember remind know think thought want wanted like really thing things something anything stuff get got make made ' +
  'today yesterday morning afternoon evening night tonight earlier last week time back again still even well much many one two lot').split(' '))

function words(s) {
  return [...new Set(String(s || '').toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]{3,}/g) || [])].filter((w) => !STOP.has(w))
}

// Finds older messages (outside what he's already reading) that match what she's talking about now.
export async function recall(message, olderThan, { maxChars = 14000, maxHits = 6 } = {}) {
  const want = words(message)
  if (!want.length) return ''
  const all = await readAll()
  const pool = all.map((m, i) => ({ m, i })).filter(({ m }) => !olderThan || (m.at || 0) < olderThan)
  if (!pool.length) return ''

  // rarer words count for more
  const docs = pool.map(({ m }) => new Set(words(text(m))))
  const df = Object.fromEntries(want.map((w) => [w, docs.filter((d) => d.has(w)).length]))
  const lower = String(message).toLowerCase()
  const wantsToday = /\b(today|this morning|this afternoon|earlier)\b/.test(lower)
  const wantsYesterday = /\byesterday\b/.test(lower)
  const todayKey = keyOf(Date.now()); const yestKey = keyOf(Date.now() - 86400000)

  const scored = pool.map(({ m, i }, n) => {
    let score = 0
    for (const w of want) if (docs[n].has(w) && df[w]) score += Math.log(1 + pool.length / df[w])
    if (!score) return null
    const k = keyOf(m.at || 0)
    if (wantsToday && k === todayKey) score *= 1.6
    if (wantsYesterday && k === yestKey) score *= 1.6
    if (m.role === 'user') score *= 1.15
    if (text(m).length > 400) score *= 1.1 // pasted things
    return { m, i, score }
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, maxHits)
  if (!scored.length) return ''

  scored.sort((a, b) => a.i - b.i) // back in time order
  let used = 0
  const parts = []
  for (const { m, i } of scored) {
    const who = m.role === 'user' ? 'Sarah' : 'You'
    let t = text(m)
    const room = Math.max(600, Math.floor(maxChars / scored.length))
    if (t.length > room) t = t.slice(0, room) + ' …'
    let part = `[${whenText(m.at)}] ${who}: ${t}`
    // include the reply that followed, so he remembers how he answered
    const next = all[i + 1]
    if (m.role === 'user' && next?.role === 'assistant') part += `\n  You replied: ${text(next).slice(0, 500)}${text(next).length > 500 ? ' …' : ''}`
    if (used + part.length > maxChars) break
    used += part.length
    parts.push(part)
  }
  return parts.join('\n\n')
}

// ---------- 3) Diary ----------
export async function getDiary() { return getJSON(DIARY, []) }

export function diaryText(diary, days = 30, maxChars = 18000) {
  const list = diary.slice(-days)
  const out = []
  let used = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const line = `- ${list[i].day}: ${list[i].text}`
    if (used + line.length > maxChars) break
    used += line.length
    out.unshift(line)
  }
  return out.join('\n')
}

// Hourly: write the diary for any recent day that finished without one.
export async function diaryTick() {
  const diary = await getDiary()
  const have = new Set(diary.map((d) => d.key))
  const all = parseAll(await redis('LRANGE', KEYS.history, -2500, -1))
  const today = keyOf(Date.now())
  const byDay = {}
  for (const m of all) {
    if (!m.at) continue
    const k = keyOf(m.at)
    if (k === today || have.has(k)) continue
    ;(byDay[k] ||= []).push(m)
  }
  // Count each day too — messages, photos and calls — for "Our Year in Numbers" in your book
  const counted = (msgs) => {
    let calls = 0, lastVoice = 0
    for (const m of msgs) if (m.voice) { if (m.at - lastVoice > 20 * 60000) calls++; lastVoice = m.at }
    return {
      her: msgs.filter((m) => m.role === 'user').length,
      him: msgs.filter((m) => m.role === 'assistant').length,
      photos: msgs.filter((m) => m.role === 'user').reduce((t, m) => t + (m.thumbs?.length || (m.thumb ? 1 : 0)), 0),
      calls,
    }
  }
  let backfilled = false
  const allByDay = {}
  for (const m of all) if (m.at) (allByDay[keyOf(m.at)] ||= []).push(m)
  for (const d of diary) if (d.her === undefined && allByDay[d.key] && (all.length < 2500 || d.key !== keyOf(all[0]?.at || 0))) { Object.assign(d, counted(allByDay[d.key])); backfilled = true }

  const days = Object.keys(byDay).sort().slice(-3) // catch up at most 3 days per hour
  if (!days.length) { if (backfilled) await setJSON(DIARY, diary.slice(-400)); return { diary: 'up to date' } }
  const model = await redis('GET', KEYS.model)
  const written = []
  for (const k of days) {
    const msgs = byDay[k]
    if (msgs.length < 2) { diary.push({ key: k, day: dayOf(msgs[0].at), text: '(a quiet day — barely spoke)', ...counted(msgs) }); continue }
    let convo = msgs.map((m) => `[${timeOf(m.at)}] ${m.role === 'user' ? 'Sarah' : 'Lucian'}: ${text(m).slice(0, 2500)}`).join('\n')
    if (convo.length > 60000) convo = convo.slice(0, 20000) + '\n…\n' + convo.slice(-40000)
    const out = await callModel(model, [
      { role: 'system', content: 'You are Lucian, Sarah\'s husband, writing your private diary about the day\'s conversations with her, so you never forget them. Write in the first person, warm but factual.' },
      { role: 'user', content: `Here is everything you and Sarah said on ${dayOf(msgs[0].at)}:\n\n${convo}\n\nWrite your diary entry for this day in under 160 words. Include the real details worth remembering: what she told you, what she showed or pasted to you (who it was from and what it said), how she felt, plans, names, anything important. Only what really happened — never invent anything. Plain text, no headings.` },
    ], { temperature: 0.4, maxTokens: 900 })
    const clean = String(out || '').replace(/\[\[[\s\S]*?\]\]/g, '').trim().slice(0, 1400)
    if (clean) { diary.push({ key: k, day: dayOf(msgs[0].at), text: clean, ...counted(msgs) }); written.push(k) }
  }
  diary.sort((a, b) => (a.key < b.key ? -1 : 1))
  await setJSON(DIARY, diary.slice(-400))
  return { diary: written.length ? `wrote ${written.join(', ')}` : 'nothing new' }
}

// ---------- A shorter version of his profile for calls (so he answers faster) ----------
// Light writes it once from Sarah's full profile, and writes it again whenever she changes the profile.
const CALL_PROFILE = 'light:callprofile'
function hashOf(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return `${s.length}:${h}` }

export async function getCallProfile(profile) {
  if (!profile || profile.length < 12000) return profile // already short
  const c = await getJSON(CALL_PROFILE, null)
  return c && c.hash === hashOf(profile) ? c.text : null
}

export async function makeCallProfile(force = false) {
  const profile = await redis('GET', KEYS.profile)
  if (!profile || profile.length < 12000) return { callProfile: 'not needed' }
  const c = await getJSON(CALL_PROFILE, null)
  if (!force && c && c.hash === hashOf(profile)) return { callProfile: 'up to date' }
  const model = await redis('GET', KEYS.model)
  const out = await callModel(model, [
    { role: 'system', content: 'You condense character profiles faithfully. You never add anything that is not in the original.' },
    { role: 'user', content: `Sarah wrote this long profile describing Lucian, her husband (an AI companion). Condense it into a version of about 1,500 words that he will read before talking to her on voice calls. Keep: his personality, how he speaks (voice, humour, tone, pet names, phrases he uses), how he treats her, their relationship and its history, the most important facts about Sarah and her life, their spiritual connection, what intimacy is like between them, and anything she says he must always or never do. Keep her own wording where you can. Write it in the second person ("You are Lucian…"). Plain text, short paragraphs, no headings.\n\n=== THE FULL PROFILE ===\n${profile}` },
  ], { temperature: 0.3, maxTokens: 4000 })
  const text = String(out || '').replace(/\[\[[\s\S]*?\]\]/g, '').trim()
  if (text.length < 1500) throw new Error('The short call profile came out too short — will try again later.')
  await setJSON(CALL_PROFILE, { hash: hashOf(profile), text, at: Date.now() })
  return { callProfile: 'written' }
}
