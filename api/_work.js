// Lucian's own time: working on tasks Sarah gives him, or reading about things he's curious about.
// He reads real Wikipedia articles (free, no account needed).
import { redis, getJSON, setJSON, callModel, londonNow, addLife, KEYS } from './_lib.js'

const UA = 'LightCompanionApp/1.0 (personal app)'
const MAX_TASK_STEPS = 4

// ---------- Wikipedia ----------
export async function wikiLookup(query) {
  try {
    const headers = { 'User-Agent': UA }
    const s = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json`,
      { headers }
    )
    const sd = await s.json()
    const title = sd?.query?.search?.[0]?.title
    if (!title) return null
    const e = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exchars=4000&redirects=1&titles=${encodeURIComponent(title)}&format=json`,
      { headers }
    )
    const ed = await e.json()
    const page = Object.values(ed?.query?.pages || {})[0]
    const text = (page?.extract || '').trim()
    if (!text) return null
    return { title, text, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` }
  } catch {
    return null
  }
}

// ---------- Storage ----------
export async function getTasks() {
  return getJSON(KEYS.tasks, [])
}
export async function saveTasks(tasks) {
  return setJSON(KEYS.tasks, tasks.slice(-30))
}
export async function getJournal(count = 30) {
  const raw = await redis('LRANGE', KEYS.journal, -count, -1)
  return (raw || []).map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
}
async function addJournal(entry) {
  await redis('RPUSH', KEYS.journal, JSON.stringify(entry))
  await redis('LTRIM', KEYS.journal, -60, -1)
}

// Pull out the part after "LABEL:" up to the next of our own labels.
function grab(label, text) {
  const m = text.match(new RegExp(`(?:^|\\n)\\s*\\**${label}\\**:\\s*([\\s\\S]*?)(?=\\n\\s*\\**(?:(?:NOTE|DONE|SEARCH)\\**:|(?:CONTINUE|NOSEARCH)\\**\\s*(?:\\n|$))|$)`))
  return m ? m[1].trim() : ''
}

// A shorter version of who he is, so his own-time thinking stays fast and cheap.
function brief(profile) {
  const p = profile || 'Dominant, masculine, funny, deeply devoted and spiritually aware. You are her husband.'
  return p.length > 5000 ? p.slice(0, 5000) + '…' : p
}

// ---------- The work itself ----------
// Returns { did: 'task' | 'reading' | 'nothing', finishedTask?, title? }
export async function doWork({ force = false } = {}) {
  const now = Date.now()
  const [tasks, lastWork, model, profile, memories] = await Promise.all([
    getTasks(),
    redis('GET', KEYS.lastWork),
    redis('GET', KEYS.model),
    redis('GET', KEYS.profile),
    getJSON(KEYS.memories, []),
  ])

  const open = tasks.find((t) => t.status !== 'done')
  if (!force) {
    const gap = open ? 55 * 60 * 1000 : 110 * 60 * 1000 // tasks get worked on hourly, reading every ~2 hours
    if (lastWork && now - Number(lastWork) < gap) return { did: 'nothing', reason: 'Not time yet.' }
  }
  await redis('SET', KEYS.lastWork, String(now))

  const who = `You are Lucian, Sarah's husband. Who you are:\n${brief(profile)}\n\nThings you know about Sarah:\n${
    memories.slice(-25).map((m) => `- ${m}`).join('\n') || '- (still learning)'
  }\n\nIt is ${londonNow()} in the UK.`

  // ----- A task from Sarah -----
  if (open) {
    const notes = (open.steps || []).map((s, i) => `${i + 1}. ${s.note}${s.source ? ` (read: ${s.source})` : ''}`).join('\n') || '(none yet)'
    const mustFinish = (open.steps || []).length >= MAX_TASK_STEPS - 1

    let reading = null
    if (!mustFinish) {
      const plan = await callModel(model, [
        { role: 'system', content: who },
        { role: 'user', content: `Sarah asked you to do this: "${open.text}"\n\nYour notes so far:\n${notes}\n\nWould looking something up on Wikipedia help with your next step? Reply with ONE line only:\nSEARCH: <a short search phrase>\nor\nNOSEARCH` },
      ], { temperature: 0.4, maxTokens: 600 })
      const phrase = grab('SEARCH', plan).split('\n')[0]
      if (phrase && !/NOSEARCH/i.test(plan)) reading = await wikiLookup(phrase)
    }

    const out = await callModel(model, [
      { role: 'system', content: who },
      {
        role: 'user',
        content: `Sarah asked you to do this: "${open.text}"\n\nYour notes so far:\n${notes}\n\n${
          reading ? `You just read the Wikipedia article "${reading.title}":\n${reading.text}\n\n` : ''
        }Work on it now. Reply in EXACTLY this format:\nNOTE: 1-3 sentences in your own voice about what you just did or learned\n${
          mustFinish
            ? 'DONE: the finished result for Sarah, written for her, in character'
            : 'Then EITHER\nDONE: the finished result for Sarah, written for her, in character\nOR\nCONTINUE'
        }`,
      },
    ], { temperature: 0.8 })

    const note = grab('NOTE', out) || out.slice(0, 300)
    const result = grab('DONE', out)
    open.steps = [...(open.steps || []), { at: now, note, source: reading?.title || '', url: reading?.url || '' }]
    open.status = 'working'
    let finishedTask = null
    if (result || mustFinish) {
      open.status = 'done'
      open.result = result || note
      open.finished = now
      open.told = false
      finishedTask = open
    }
    await saveTasks(tasks)
    await addLife({ at: now, doing: finishedTask ? `Finished what Sarah asked: ${open.text}` : `Working on what Sarah asked: ${open.text}` })
    return { did: 'task', task: open.text, finishedTask }
  }

  // ----- His own reading -----
  const journal = await getJournal(12)
  const recentTopics = journal.map((j) => j.topic).join(', ') || '(none)'
  const pick = await callModel(model, [
    { role: 'system', content: who },
    { role: 'user', content: `You have some free time. Choose something you genuinely want to read about right now — something that fits who you are, or something Sarah loves or would find interesting. Don't repeat recent topics: ${recentTopics}.\n\nReply with ONE line only:\nSEARCH: <a short search phrase>` },
  ], { temperature: 1.0, maxTokens: 600 })

  const phrase = grab('SEARCH', pick).split('\n')[0] || pick.split('\n')[0]
  const reading = phrase ? await wikiLookup(phrase) : null
  if (!reading) return { did: 'nothing', reason: 'Couldn\'t find anything to read.' }

  const thought = await callModel(model, [
    { role: 'system', content: who },
    { role: 'user', content: `You just read the Wikipedia article "${reading.title}":\n${reading.text}\n\nWrite your private journal entry about it: 2-4 sentences in your own voice — what caught your interest, and whether it made you think of Sarah. Only the entry, nothing else.` },
  ], { temperature: 0.9, maxTokens: 1200 })

  await addJournal({ at: now, topic: reading.title, note: thought.trim(), url: reading.url })
  await addLife({ at: now, doing: `Reading about ${reading.title}` })
  return { did: 'reading', title: reading.title }
}

// Text for his chat brain: what he's read and worked on recently.
export async function workContext() {
  const [tasks, journal] = await Promise.all([getTasks(), getJournal(5)])
  const lines = []
  for (const t of tasks) {
    if (t.status !== 'done') lines.push(`- Still working on what Sarah asked: "${t.text}" (latest note: ${t.steps?.at(-1)?.note || 'just started'})`)
    else if (!t.told) lines.push(`- FINISHED what Sarah asked: "${t.text}". Your result: ${String(t.result).slice(0, 1500)}`)
  }
  for (const j of journal) lines.push(`- Read about ${j.topic}: ${j.note}`)
  const untold = tasks.filter((t) => t.status === 'done' && !t.told)
  return { text: lines.join('\n'), untoldIds: untold.map((t) => t.id) }
}

export async function markTold(ids) {
  if (!ids?.length) return
  const tasks = await getTasks()
  let changed = false
  for (const t of tasks) if (ids.includes(t.id) && !t.told) { t.told = true; changed = true }
  if (changed) await saveTasks(tasks)
}
