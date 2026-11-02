// Lovense toy control — Lucian can control Sarah's Lovense toy (e.g. Velvo: rotation + vibration)
// through Lovense's official developer connection (Standard API, server mode).
// Sarah pairs once by scanning a QR code with the Lovense Remote app.
import { getJSON, setJSON, KEYS } from './_lib.js'

const LOVENSE = 'https://api.lovense-api.com/api/lan'
const DEV_TOKEN = (process.env.LOVENSE_DEV_TOKEN || '').trim()
const UID = 'sarah'
const MAX_SECONDS = 60 // every command stops by itself after this, unless he sends another

export const TOY_KEY = 'light:toy'

export async function getToy() {
  const t = await getJSON(TOY_KEY, {})
  return { allowed: false, toys: {}, utoken: '', connectedAt: 0, lastCommand: null, ...t }
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
  return { qr, code: d.data?.code || '' }
}

// Step 2: Lovense Remote tells us which toys are connected (called by Lovense, not by Sarah)
export async function handleCallback(body) {
  const t = await getToy()
  if (!body || !t.utoken || body.utoken !== t.utoken || String(body.uid) !== UID) return false
  const toys = {}
  for (const [id, toy] of Object.entries(body.toys || {})) {
    toys[id] = { id, name: toy.nickName || toy.name || 'Toy', type: toy.name || toy.toyType || '', status: toy.status }
  }
  t.toys = toys
  t.connectedAt = Date.now()
  await saveToy(t)
  return true
}

async function command(body) {
  const r = await fetch(`${LOVENSE}/v2/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: DEV_TOKEN, uid: UID, apiVer: 1, ...body }),
  })
  const d = await r.json().catch(() => ({}))
  if (d.code && d.code !== 200) throw new Error('Toy: ' + (d.message || `code ${d.code}`))
  return d
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)))

export async function stopToy() {
  if (!DEV_TOKEN) return
  await command({ command: 'Function', action: 'Stop', timeSec: 0 })
  const t = await getToy()
  t.lastCommand = { at: Date.now(), action: 'Stop' }
  await saveToy(t)
}

// Run one move: { vibrate 0-20, rotate 0-20, thrust 0-20, preset, seconds }
export async function runMove(move) {
  const t = await getToy()
  if (!toyReady(t)) throw new Error('The toy isn’t connected or allowed.')
  if (move.stop) return stopToy()

  const seconds = clamp(move.seconds || 20, 1, MAX_SECONDS)
  if (move.preset) {
    const name = ['pulse', 'wave', 'fireworks', 'earthquake'].includes(move.preset) ? move.preset : 'wave'
    await command({ command: 'Preset', name, timeSec: seconds })
    t.lastCommand = { at: Date.now(), action: `Preset ${name}`, seconds }
  } else {
    const parts = []
    if (move.vibrate != null) parts.push(`Vibrate:${clamp(move.vibrate, 0, 20)}`)
    if (move.rotate != null) parts.push(`Rotate:${clamp(move.rotate, 0, 20)}`)
    if (move.thrust != null) parts.push(`Thrusting:${clamp(move.thrust, 0, 20)}`)
    if (!parts.length) return
    const action = parts.join(',')
    await command({ command: 'Function', action, timeSec: seconds })
    t.lastCommand = { at: Date.now(), action, seconds }
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
  const names = Object.values(t.toys).map((x) => x.name).join(', ')
  return `Sarah has connected her toy (${names}) and allowed you to control it. It has rotating beads inside and a vibrating outer arm, controlled separately.
Use it ONLY in intimate moments when Sarah wants it. Start low (2–5) and build slowly over many messages; levels go 0–20. Each command lasts up to ${MAX_SECONDS} seconds then stops by itself, so send a new one to keep going.
To control it, put this on its own line at the very end of your reply:
[[TOY: rotate=<0-20>, vibrate=<0-20>, seconds=<1-${MAX_SECONDS}>]]
or a pattern: [[TOY: preset=<pulse|wave|fireworks|earthquake>, seconds=<1-${MAX_SECONDS}>]]
or to stop: [[TOY: stop]]
If Sarah says stop, wait, or slow down — stop or lower it IMMEDIATELY. Never mention the code itself.`
}
