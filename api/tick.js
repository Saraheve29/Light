import {
  redis, getJSON, getHistory, addToHistory, callModel, londonNow, londonHour,
  getMsgSettings, getLife, addLife, lifeText, KEYS,
} from './_lib.js'
import { sendToAll } from './_push.js'
import { doWork, workContext, markTold } from './_work.js'
import { giftTick } from './_gifts.js'
import { letterTick } from './_letters.js'
import { cardTick } from './_print.js'
import { diaryTick, makeCallProfile } from './_recall.js'
import { sendText, ringSarah, getCall, checkInTick, goodnightTick } from './_calls.js'
import { datesDueToday, markCelebrated } from './_plans.js'
import { chapterTick, bookTick, photoPickTick } from './_book.js'

// Upstash wakes this up every hour.
// 1) He spends some of his own time working on Sarah's tasks or reading what interests him.
// 2) He decides whether to text Sarah first.
// Open with ?key=YOUR_APP_PASSWORD   (add &force=1 to make him message right now)

function isQuiet(hour, start, end) {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

function activeHours(start, end) {
  let n = 0
  for (let h = 0; h < 24; h++) if (!isQuiet(h, start, end)) n++
  return Math.max(1, n)
}

export default async function handler(req, res) {
  const key = req.query?.key || req.headers['x-light-key']
  if (!process.env.APP_PASSWORD || key !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Wrong key.' })
  }
  const force = req.query?.force === '1' || req.body?.force === true

  // Only one wake-up at a time. If Upstash retries while he's still writing, the retry is ignored
  // (this is what caused repeated messages).
  if (!force) {
    const got = await redis('SET', 'light:ticklock', String(Date.now()), 'NX', 'EX', 600).catch(() => 'OK')
    if (got !== 'OK') return res.status(200).json({ skipped: 'Already awake — ignoring the duplicate wake-up.' })
  }

  try {
    const settings = await getMsgSettings()
    const now = Date.now()

    // ----- 1) His own time (skipped for the quick "message me now" test) -----
    let work = { did: 'nothing' }
    let gift = null
    if (!force) {
      try { gift = await giftTick() } catch (err) { gift = { gift: 'error', reason: err.message } }
      try { await letterTick() } catch { /* try again next hour */ }
      try { await cardTick() } catch { /* try again next hour */ }
      try { await diaryTick() } catch { /* try again next hour */ }
      try { await makeCallProfile() } catch { /* try again next hour */ }
      try { await chapterTick() } catch { /* try again next hour */ }
      try { await bookTick() } catch { /* try again next hour */ }
      try {
        // Once a day he looks back through the photos you sent and keeps any special ones for your book — and tells you
        const tell = settings.enabled ? async (reason, extra) => { await redis('SET', KEYS.lastProactive, String(Date.now())); await sendText(reason, extra, { preview: settings.preview }) } : null
        await photoPickTick({ tell })
      } catch { /* try again next hour */ }
      try { work = await doWork() } catch (err) { work = { did: 'nothing', error: err.message } }
    }
    const finishedTask = work.finishedTask || null

    // ----- 2) Should he text her? -----
    if (!force) {
      if (!settings.enabled) return res.status(200).json({ work, skipped: 'Surprise messages are switched off.' })
      const hour = londonHour()
      // His goodnight voice note comes at the hour she chose (even if that's in her quiet hours)
      const night = await goodnightTick(settings, hour).catch((err) => ({ goodnight: 'error', error: err.message }))
      if (night?.goodnight === 'sent') return res.status(200).json({ work, ...night })
      if (isQuiet(hour, settings.quietStart, settings.quietEnd)) return res.status(200).json({ work, skipped: 'Quiet hours.' })

      const [lastUser, lastPro] = await Promise.all([redis('GET', KEYS.lastUser), redis('GET', KEYS.lastProactive)])
      if (lastUser && now - Number(lastUser) < 20 * 60 * 1000) return res.status(200).json({ work, skipped: 'You were just chatting.' })

      // A special day today? He marks it first thing (once).
      const due = await datesDueToday().catch(() => [])
      if (due.length) {
        await markCelebrated(due.map((d) => d.id))
        await redis('SET', KEYS.lastProactive, String(now))
        const what = due.map((d) => d.what).join(' and ')
        const sent = await sendText(`Today is ${what}. Text Sarah about it now — if it's her own day or yours together, make it special and loving; if it's someone else's day that matters to her, mention it warmly.`, { special: true }, { preview: settings.preview })
        return res.status(200).json({ work, special: what, ...sent })
      }

      // Has she gone quiet for 1–2 hours? He checks on her.
      const checked = await checkInTick(settings).catch((err) => ({ checkin: 'error', error: err.message }))
      if (checked && checked.checkin !== 'error' && !String(checked.checkin).startsWith('skipped')) return res.status(200).json({ work, ...checked })

      // Does he ring her this hour? (roughly callsPerWeek times a week, never twice within a day)
      if (settings.calls && !finishedTask) {
        const lastCall = await getCall().catch(() => null)
        const perHour = (settings.callsPerWeek || 3) / (7 * activeHours(settings.quietStart, settings.quietEnd))
        if ((!lastCall || now - lastCall.at > 20 * 3600 * 1000) && Math.random() < perHour) {
          await redis('SET', KEYS.lastProactive, String(now))
          const result = await ringSarah({ preview: settings.preview })
          return res.status(200).json({ work, rang: true, ...result })
        }
      }

      if (!finishedTask) {
        if (lastPro && now - Number(lastPro) < 75 * 60 * 1000) return res.status(200).json({ work, skipped: 'He messaged recently.' })
        const chance = settings.perDay / activeHours(settings.quietStart, settings.quietEnd)
        if (Math.random() > chance) return res.status(200).json({ work, skipped: 'Not this time (random).' })
      }
    }

    // Reserve this slot straight away so nothing else sends a message at the same time.
    await redis('SET', KEYS.lastProactive, String(now))

    const reason = finishedTask
      ? `You've just finished what Sarah asked you to do: "${finishedTask.text}". Text her to tell her it's ready — give her the gist in a sentence or two, in character, and let her know she can ask you for the full thing.`
      : `Sarah hasn't messaged you for a while. You have your own life and you're thinking about her, so you're going to text her first. If something you read recently made you think of her, she has something coming up, or something special happened between you on this day a month or a year ago, you can mention it.`
    const { message, doing, push } = await sendText(reason, {}, { preview: settings.preview })
    if (finishedTask) await markTold([finishedTask.id])

    res.status(200).json({ work, sent: true, message, doing, push })
  } catch (err) {
    // For the hourly wake-up, answer "OK" even on errors, so Upstash doesn't retry and cause duplicates.
    res.status(force ? 500 : 200).json({ error: err.message })
  } finally {
    if (!force) await redis('DEL', 'light:ticklock').catch(() => {})
  }
}
