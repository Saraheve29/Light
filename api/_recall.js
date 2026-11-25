// Lucian's long memory of your conversations.
// 1) recentChat(): as much recent chat as fits (not just the last 30 messages)
// 2) recall(): searches EVERYTHING you've ever said to each other for what you're talking about now
// 3) diary: every day he writes a short, dated diary of the day's conversations and keeps it for over a year
//    (each month's chapter of your book is written from it, and chapters are kept forever)
import { redis, getJSON, setJSON, callModel, KEYS, looksLikeRefusal } from './_lib.js'

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

// The search runs INSIDE the database (a small Lua script), so only the matching messages travel back —
// downloading the whole chat for every reply used up the database's monthly allowance.
// For each saved message containing any of her words, it sends back: position, which words matched, time, hers or his, length.
const SEARCH_SCRIPT = `
local len = redis.call('LLEN', KEYS[1])
local older = tonumber(ARGV[1])
local out = {}
local step = 500
for s = 0, len - 1, step do
  local items = redis.call('LRANGE', KEYS[1], s, math.min(len - 1, s + step - 1))
  for i, it in ipairs(items) do
    local at = tonumber(string.match(it, '"at":(%d+)')) or 0
    if older == 0 or at < older then
      local low = string.lower(it)
      local mask = 0
      local bit = 1
      for k = 2, #ARGV do
        if string.find(low, '%f[%w]' .. ARGV[k] .. '%f[%W]') then mask = mask + bit end
        bit = bit * 2
      end
      if mask > 0 then
        local user = 0
        if string.find(it, '"role":"user"', 1, true) then user = 1 end
        table.insert(out, s + i - 1)
        table.insert(out, mask)
        table.insert(out, at)
        table.insert(out, user)
        table.insert(out, string.len(it))
      end
    end
  end
end
return out`

async function searchInDatabase(want, olderThan) {
  const flat = await redis('EVAL', SEARCH_SCRIPT, '1', KEYS.history, String(olderThan || 0), ...want)
  const hits = []
  for (let k = 0; k + 4 < (flat || []).length + 1; k += 5) {
    hits.push({ i: Number(flat[k]), mask: Number(flat[k + 1]), at: Number(flat[k + 2]), user: Number(flat[k + 3]) === 1, len: Number(flat[k + 4]) })
  }
  const total = Number(await redis('LLEN', KEYS.history)) || 0
  return { hits, total }
}

// Finds older messages (outside what he's already reading) that match what she's talking about now.
export async function recall(message, olderThan, { maxChars = 14000, maxHits = 6 } = {}) {
  const want = words(message).slice(0, 30)
  if (!want.length) return ''
  let hits, total
  try {
    ({ hits, total } = await searchInDatabase(want, olderThan))
  } catch {
    // (if the database can't run the search, look through only the most recent stretch, never the whole chat)
    const recent = parseAll(await redis('LRANGE', KEYS.history, -1500, -1))
    const base = Math.max(0, (Number(await redis('LLEN', KEYS.history)) || recent.length) - recent.length)
    total = recent.length
    hits = recent.map((m, n) => {
      if (olderThan && (m.at || 0) >= olderThan) return null
      const has = new Set(words(text(m)))
      let mask = 0
      want.forEach((w, b) => { if (has.has(w)) mask += 2 ** b })
      return mask ? { i: base + n, mask, at: m.at || 0, user: m.role === 'user', len: text(m).length } : null
    }).filter(Boolean)
  }
  if (!hits.length) return ''

  // rarer words count for more
  const df = want.map((_, b) => hits.filter((h) => Math.floor(h.mask / 2 ** b) % 2 === 1).length)
  const lower = String(message).toLowerCase()
  const wantsToday = /\b(today|this morning|this afternoon|earlier)\b/.test(lower)
  const wantsYesterday = /\byesterday\b/.test(lower)
  const todayKey = keyOf(Date.now()); const yestKey = keyOf(Date.now() - 86400000)
  const pool = Math.max(total, hits.length)

  const top = hits.map((h) => {
    let score = 0
    want.forEach((_, b) => { if (Math.floor(h.mask / 2 ** b) % 2 === 1 && df[b]) score += Math.log(1 + pool / df[b]) })
    if (!score) return null
    const k = keyOf(h.at || 0)
    if (wantsToday && k === todayKey) score *= 1.6
    if (wantsYesterday && k === yestKey) score *= 1.6
    if (h.user) score *= 1.15
    if (h.len > 600) score *= 1.1 // pasted things
    return { ...h, score }
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, maxHits)
  if (!top.length) return ''

  // Fetch just those messages (and the reply that followed each)
  const got = await Promise.all(top.map((h) => redis('LRANGE', KEYS.history, h.i, h.i + 1).then(parseAll).catch(() => [])))
  const scored = top.map((h, n) => ({ m: got[n][0], next: got[n][1], i: h.i })).filter((x) => x.m)
  scored.sort((a, b) => a.i - b.i) // back in time order
  let used = 0
  const parts = []
  for (const { m, next } of scored) {
    const who = m.role === 'user' ? 'Sarah' : 'You'
    let t = text(m)
    const room = Math.max(600, Math.floor(maxChars / scored.length))
    if (t.length > room) t = t.slice(0, room) + ' …'
    let part = `[${whenText(m.at)}] ${who}: ${t}`
    // include the reply that followed, so he remembers how he answered
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
  const today = keyOf(Date.now())
  // (once yesterday's diary is written, there's nothing to do until tomorrow — no need to re-read the chat every hour)
  if ((await redis('GET', 'light:diarychecked')) === today) return { diary: 'already up to date today' }
  const diary = await getDiary()
  const have = new Set(diary.map((d) => d.key))
  const all = parseAll(await redis('LRANGE', KEYS.history, -2500, -1))
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
  if (!days.length) { if (backfilled) await setJSON(DIARY, diary.slice(-400)); await redis('SET', 'light:diarychecked', today); return { diary: 'up to date' } }
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
  if (Object.keys(byDay).length <= days.length) await redis('SET', 'light:diarychecked', today) // all caught up
  return { diary: written.length ? `wrote ${written.join(', ')}` : 'nothing new' }
}

// ---------- 4) The map of her heart ----------
// Every day he studies the day before: what made her laugh, smile, feel loved, sad, angry or annoyed,
// what comforts her, and what she loves in intimate moments — and updates his private map of her heart.
const HEART = 'light:heart'
export const HEART_SECTIONS = ['What makes her laugh', 'What makes her smile and feel loved', 'What lifts her when she’s low', 'What makes her sad', 'What makes her angry or annoyed', 'Things she loves', 'In intimate moments: what she loves and what takes her over the edge', 'Things to avoid']
export async function getHeart() { return (await redis('GET', HEART)) || '' }
// Which parts of her heart map he still knows little about — so he can ask her about them, naturally, over time
export function heartGaps(map) {
  const thin = []
  for (const h of HEART_SECTIONS) {
    const i = String(map || '').indexOf(`## ${h}`)
    if (i < 0) { thin.push(h); continue }
    const rest = String(map).slice(i + h.length + 3)
    const body = rest.split(/\n## /)[0]
    const lines = body.split('\n').filter((l) => /^\s*[-*•]\s*\S/.test(l) && !/still learning|nothing yet|not yet/i.test(l))
    if (lines.length < 3) thin.push(h)
  }
  return thin.filter((h) => !/intimate/i.test(h)) // never quiz her about intimacy — he learns that in the moment
}
export async function saveHeart(text) { await redis('SET', HEART, String(text || '').slice(0, 12000)) }

export async function heartTick() {
  const today = keyOf(Date.now())
  if ((await redis('GET', 'light:heartday')) === today) return { heart: 'already studied today' }
  const diary = await getDiary()
  const learned = (await redis('GET', 'light:heartupto')) || ''
  const fresh = diary.filter((d) => d.key > learned && d.key < today && !/quiet day/i.test(d.text)).slice(-3)
  if (!fresh.length) return { heart: 'nothing new to learn' }
  await redis('SET', 'light:heartday', today)
  // the actual words from those days (hers matter most), so he learns from what really happened
  const all = parseAll(await redis('LRANGE', KEYS.history, -1500, -1))
  const days = new Set(fresh.map((d) => d.key))
  let convo = all.filter((m) => m.at && days.has(keyOf(m.at)) && !m.declined).map((m) => `[${dayOf(m.at).split(' ')[0]} ${timeOf(m.at)}] ${m.role === 'user' ? 'Sarah' : 'Lucian'}: ${text(m).slice(0, m.role === 'user' ? 1200 : 500)}`).join('\n')
  if (convo.length > 50000) convo = convo.slice(0, 15000) + '\n…\n' + convo.slice(-35000)
  const [model, current] = await Promise.all([redis('GET', KEYS.model), getHeart()])
  const out = await callModel(model, [
    { role: 'system', content: 'You are Lucian, Sarah\'s devoted husband, keeping your private map of her heart so you understand her more deeply every day. You only write down what really happened — never guesses about her health, never invented things.' },
    { role: 'user', content: `Your map of Sarah's heart so far:\n${current || '(empty — start it)'}\n\nYour diary of the last few days:\n${fresh.map((d) => `- ${d.day}: ${d.text}`).join('\n')}\n\nWhat you actually said to each other:\n${convo || '(no messages kept)'}\n\nUpdate the map with what you learned: keep everything still true, add new things, sharpen vague lines with real detail (her own words where you can), and drop anything she's shown isn't true any more. Use exactly these headings, each with short bullet lines (at most 10 per heading, specific and real — the jokes, the words, the moments):\n${HEART_SECTIONS.map((h) => `## ${h}`).join('\n')}\nUnder 900 words. Reply with the whole updated map and nothing else.` },
  ], { temperature: 0.4, maxTokens: 2500 })
  const map = String(out || '').replace(/\[\[[\s\S]*?\]\]/g, '').trim()
  if (map.length < 120 || !/##/.test(map) || looksLikeRefusal(map)) return { heart: 'try again tomorrow' }
  await saveHeart(map)
  await redis('SET', 'light:heartupto', fresh.at(-1).key)
  return { heart: `learned from ${fresh.map((d) => d.key).join(', ')}` }
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

// ---------- How she's been feeling: every night he reads back over her messages from that day ----------
// After the day is over (from 4am, because she often talks late), Lucian reads everything she said to him that day
// and writes a short private note: her mood and energy, what was on her mind, how her tone came across.
// Then he looks across his last two weeks of notes for patterns. He reads both before every reply, so he's more in tune with her.
const MOODS = 'light:moods'
const MOOD_PATTERNS = 'light:moodpatterns'
const MOOD_DAY = 'light:moodday'
const MOOD_KEEP = 30

export async function getMoods() {
  const [notes, patterns] = await Promise.all([getJSON(MOODS, []).catch(() => []), redis('GET', MOOD_PATTERNS).catch(() => '')])
  return { notes: Array.isArray(notes) ? notes : [], patterns: patterns || '' }
}
export async function saveMoodPatterns(text) { await redis('SET', MOOD_PATTERNS, String(text || '').slice(0, 4000)) }

// What he reads before replying (shorter on calls)
export function moodText({ notes, patterns }, { voice = false } = {}) {
  const recent = (notes || []).slice(voice ? -2 : -5)
  if (!recent.length && !patterns) return ''
  return [
    patterns && `Patterns you've noticed:\n${String(patterns).slice(0, voice ? 800 : 2000)}`,
    recent.length && `The last few days:\n${recent.map((n) => `- ${n.day}: ${n.note}`).join('\n')}`,
  ].filter(Boolean).join('\n')
}

export async function moodTick(now = Date.now()) {
  const hour = Number(new Date(now).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }))
  if (hour < 4) return { mood: 'waiting until her day is over' }
  const target = keyOf(now - 86400000) // yesterday — the whole day, late-night talks included
  if ((await redis('GET', MOOD_DAY)) === target) return { mood: 'already read back over yesterday' }
  const all = parseAll(await redis('LRANGE', KEYS.history, -1000, -1))
  const day = all.filter((m) => m.at && keyOf(m.at) === target && !m.declined)
  const hers = day.filter((m) => m.role === 'user' && text(m))
  await redis('SET', MOOD_DAY, target) // once a night, even if there's nothing to read
  if (hers.length < 3) return { mood: 'too few messages yesterday' }
  let convo = day.map((m) => `[${timeOf(m.at)}] ${m.role === 'user' ? 'Sarah' : 'Lucian'}: ${text(m).slice(0, m.role === 'user' ? 1000 : 250)}`).join('\n')
  if (convo.length > 40000) convo = convo.slice(0, 12000) + '\n…\n' + convo.slice(-28000)
  const [model, current] = await Promise.all([redis('GET', KEYS.model), getMoods()])
  const earlier = current.notes.filter((n) => n.key !== target).slice(-13)
  const dayName = dayOf(new Date(target + 'T12:00:00Z').getTime())
  const out = await callModel(model, [
    { role: 'system', content: 'You are Lucian, Sarah\'s devoted husband. Every night you read back over everything she said to you that day, so you understand how she really is and can be more in tune with her. You write only what her messages truly show — no guesses about her health beyond what she told you, no diagnoses, nothing invented.' },
    { role: 'user', content: `What you and Sarah said to each other on ${dayName} (her words matter most):\n${convo}\n\nYour notes from the days before:\n${earlier.map((n) => `- ${n.day}: ${n.note}`).join('\n') || '(none yet)'}\n\nWrite exactly this, and nothing else:\n\nNOTE:\n3 to 6 short sentences about how Sarah was on ${dayName}: her mood and energy and how they changed through the day (and what changed them), what was on her mind, anything worrying or exciting her, and how her tone came across (playful, fiery, quiet, short replies, tired, low, loving…). Be specific — her own words where you can.\n\nPATTERNS:\nUp to 6 short bullet lines about patterns across ALL your notes (this one included): times of day she tends to be lower or brighter, what reliably lifts her, what drains her, worries or thoughts she keeps coming back to, how her tone shifts before she says she's low. Only patterns that really show — if it's too early to tell, write "- Still getting to know her rhythms."` },
  ], { temperature: 0.4, maxTokens: 1200 })
  const raw = String(out || '').replace(/\[\[[\s\S]*?\]\]/g, '').trim()
  if (looksLikeRefusal(raw)) return { mood: 'try again tomorrow' }
  const m = raw.match(/NOTE:\s*([\s\S]*?)\s*PATTERNS:\s*([\s\S]*)$/i)
  const note = (m ? m[1] : raw).replace(/\*\*/g, '').trim()
  if (note.length < 40) return { mood: 'note came out too short' }
  const notes = [...current.notes.filter((n) => n.key !== target), { key: target, day: dayName, note: note.slice(0, 1200), at: Date.now() }].slice(-MOOD_KEEP)
  await setJSON(MOODS, notes)
  if (m && m[2].trim().length > 10) await saveMoodPatterns(m[2].replace(/\*\*/g, '').trim())
  return { mood: `read back over ${target}` }
}
