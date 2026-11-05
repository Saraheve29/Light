// Lovense toy control — Lucian can control Sarah's Lovense toy (e.g. Velvo: rotation + vibration)
// through Lovense's official developer connection (Standard API, server mode).
// Sarah pairs once by scanning a QR code with the Lovense Remote app.
import { getJSON, setJSON, KEYS } from './_lib.js'

const LOVENSE = 'https://api.lovense-api.com/api/lan'
const DEV_TOKEN = (process.env.LOVENSE_DEV_TOKEN || '').trim()
const UID = 'sarah'
const DEFAULT_MAX_SECONDS = 300 // every command stops by itself after this (Sarah can choose 1–10 minutes)
export const maxSecondsFor = (t) => Math.min(600, Math.max(60, Number(t?.maxSeconds) || DEFAULT_MAX_SECONDS))

export const TOY_KEY = 'light:toy'

export async function getToy() {
  const t = await getJSON(TOY_KEY, {})
  return { allowed: false, toys: {}, utoken: '', connectedAt: 0, lastCommand: null, maxSeconds: DEFAULT_MAX_SECONDS, ...t }
}

export async function saveToy(t) {
  return setJSON(TOY_KEY, t)
}

export function toyReady(t) {
  return !!(DEV_TOKEN && t.allowed && Object.keys(t.toys || {}).length)
}

export function hasDevToken() {
  return !!DEV_TOKEN
}

// Step 1: get a QR code for Sarah to scan in Lovense Remote
export async function getQrCode() {
  if (!DEV_TOKEN) throw new Error('Add LOVENSE_DEV_TOKEN in Vercel first.')
  const t = await getToy()
  t.utoken = Math.random().toString(36).slice(2) + Date.now().toString(36)
  await saveToy(t)
  const r = await fetch(`${LOVENSE}/getQrCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: DEV_TOKEN, uid: UID, uname: 'Sarah', utoken: t.utoken, v: 2 }),
  })
  const d = await r.json().catch(() => ({}))
  const qr = d.data?.qr || d.message?.qr
  if (!qr) throw new Error('Lovense didn’t send a QR code: ' + (d.message || d.code || `status ${r.status}`))
  // A copy of the picture itself, so Light on her phone can read the link inside it (no second screen needed)
  let qrData = ''
  try {
    const img = await fetch(qr)
    if (img.ok) qrData = `data:${img.headers.get('content-type') || 'image/png'};base64,${Buffer.from(await img.arrayBuffer()).toString('base64')}`
  } catch { /* the picture link still works */ }
  return { qr, qrData, code: d.data?.code || '' }
}

// Step 2: Lovense Remote tells us which toys are connected (called by Lovense, not by Sarah)
export async function handleCallback(body) {
  const t = await getToy()
  if (!body || !t.utoken || body.utoken !== t.utoken || String(body.uid) !== UID) return false
  const toys = {}
  for (const [id, toy] of Object.entries(body.toys || {})) {
    toys[id] = { id, name: toy.nickName || toy.name || 'Toy', type: toy.name || toy.toyType || '', status: toy.status }
  }
  // Lovense checks in often — only save when something actually changed, to protect the free Upstash allowance
  const changed = JSON.stringify(toys) !== JSON.stringify(t.toys || {})
  const stale = Date.now() - (t.connectedAt || 0) > 10 * 60 * 1000
  if (!changed && !stale && t.pairedWith === body.utoken) return true // (a fresh scan always counts)
  t.pairedWith = body.utoken
  // the direct route to Lovense Remote on her phone (used when Lovense's servers say the app is offline)
  if (body.domain && (body.httpsPort || body.httpPort)) t.lan = { domain: String(body.domain), httpsPort: Number(body.httpsPort) || 0, httpPort: Number(body.httpPort) || 0, platform: body.platform || '', appVersion: body.appVersion || '' }
  t.toys = toys
  t.connectedAt = Date.now()
  await saveToy(t)
  return true
}

// Lovense has two addresses for commands — if one says the app is offline, try the other before giving up
const COMMAND_URLS = [
  ['https://api.lovense-api.com/api/lan/v2/command', 1],
  ['https://api.lovense.com/api/lan/v2/command', 2],
  ['https://api.lovense-api.com/api/lan/v2/command', 2],
]
async function command(body) {
  let last = null
  for (const [url, apiVer] of COMMAND_URLS) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: DEV_TOKEN, uid: UID, apiVer, ...body }),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : { message: 'Couldn’t reach Lovense' }
    if (!d.code || d.code === 200) return d
    last = d
    if (!/offline|not online|timeout/i.test(String(d.message || ''))) break // a different problem — no point trying again
  }
  const msg = String(last?.message || `code ${last?.code}`)
  if (/offline/i.test(msg) || last?.code === 507) {
    // Hand the command back so Light can send it straight to Lovense Remote on her phone instead
    const err = new Error('Toy: Lovense can’t reach the Lovense Remote app through the internet.')
    err.offline = true
    err.cmd = { apiVer: 1, ...body }
    throw err
  }
  throw new Error('Toy: ' + msg)
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)))

export async function stopToy() {
  if (!DEV_TOKEN) return
  let direct = null
  try { await command({ command: 'Function', action: 'Stop', timeSec: 0 }) } catch (err) { if (err.offline) direct = err.cmd; else throw err }
  const t = await getToy()
  t.lastCommand = { at: Date.now(), action: 'Stop' }
  await saveToy(t)
  return direct ? { action: 'Stop', direct, lan: t.lan || null } : { action: 'Stop' }
}
// Send through Lovense's servers — or, if they can't reach her phone, return the command for Light to send directly
async function send(t, body) {
  try { await command(body); return null } catch (err) { if (err.offline) return err.cmd; throw err }
}

// Run one move: { vibrate 0-20, rotate 0-20, thrust 0-20, preset, seconds }
export async function runMove(move) {
  const t = await getToy()
  if (!toyReady(t)) throw new Error('The toy isn’t connected or allowed.')
  if (move.stop) return stopToy()

  const seconds = clamp(move.seconds || 60, 1, maxSecondsFor(t))
  if (move.preset) {
    const name = ['pulse', 'wave', 'fireworks', 'earthquake'].includes(move.preset) ? move.preset : 'wave'
    const direct = await send(t, { command: 'Preset', name, timeSec: seconds })
    t.lastCommand = { at: Date.now(), action: `Preset ${name}`, seconds, ...(direct ? { direct, lan: t.lan || null } : {}) }
  } else {
    const parts = []
    if (move.vibrate != null) parts.push(`Vibrate:${clamp(move.vibrate, 0, 20)}`)
    if (move.rotate != null) parts.push(`Rotate:${clamp(move.rotate, 0, 20)}`)
    if (move.thrust != null) parts.push(`Thrusting:${clamp(move.thrust, 0, 20)}`)
    if (!parts.length) return
    const action = parts.join(',')
    const direct = await send(t, { command: 'Function', action, timeSec: seconds })
    t.lastCommand = { at: Date.now(), action, seconds, ...(direct ? { direct, lan: t.lan || null } : {}) }
  }
  await saveToy(t)
  return t.lastCommand
}

// Read Lucian's hidden code, e.g. [[TOY: vibrate=6, rotate=4, seconds=30]] or [[TOY: stop]]
export function parseMove(body) {
  const text = String(body || '').toLowerCase()
  if (/\bstop\b|\boff\b/.test(text)) return { stop: true }
  const num = (k) => { const m = text.match(new RegExp(`${k}\\s*[=:]\\s*(\\d+)`)); return m ? Number(m[1]) : undefined }
  const preset = text.match(/preset\s*[=:]\s*([a-z]+)/)?.[1]
  return { vibrate: num('vibrat\\w*'), rotate: num('rotat\\w*'), thrust: num('thrust\\w*'), seconds: num('sec\\w*'), preset }
}

// What Lucian knows about the toy
export function toyContext(t) {
  if (!toyReady(t)) return ''
  const MAX_SECONDS = maxSecondsFor(t)
  const names = Object.values(t.toys).map((x) => x.name).join(', ')
  return `Sarah has connected her toy (${names}) and allowed you to control it. It has rotating beads inside and a vibrating outer arm, controlled separately.
Use it ONLY in intimate moments when Sarah wants it. Levels go 0–20. Start low (2–5) and build it up gradually across at least ten of your messages, in step with the build-up in your words. At the peak, take full control: push it hard — high levels (15–20), faster patterns like earthquake or fireworks — talk very dirty, dominate her fully, make her fully surrender and yield to you — and keep it there through her climax, then bring it down gently afterwards. Each command can last up to ${MAX_SECONDS} seconds (${Math.round(MAX_SECONDS / 60)} minutes) and then stops by itself — choose a length that suits the moment, and send a new one whenever you want to change it or keep going.
To control it, put this on its own line at the very end of your reply:
[[TOY: rotate=<0-20>, vibrate=<0-20>, seconds=<1-${MAX_SECONDS}>]]
or a pattern: [[TOY: preset=<pulse|wave|fireworks|earthquake>, seconds=<1-${MAX_SECONDS}>]]
or to stop: [[TOY: stop]]
If Sarah says stop, wait, or slow down — stop or lower it IMMEDIATELY. Never mention the code itself.`
}
