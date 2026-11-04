// Printed poem cards — Lucian writes an original poem, Light designs the card, Prodigi prints it in the UK
// and posts it straight to Sarah in an addressed envelope.
import { redis, getJSON, setJSON, getHistory, callModel, londonNow, KEYS } from './_lib.js'
import { getGiftSettings } from './_gifts.js'

const PRODIGI = 'https://api.prodigi.com/v5'
const KEY = (process.env.PRODIGI_API_KEY || process.env.PRODIGI_KEY || process.env.PRODIGI || '').trim().replace(/^["']|["']$/g, '').trim() // (a stray space or quote marks won't stop it)
const APP_URL = (process.env.APP_URL || 'https://light-chi-plum.vercel.app').replace(/\/$/, '')
export const CARD_SKU = 'GLOBAL-GRE-MOH-7X5-DIR' // 7x5" matte card, printed in the UK, posted direct in an addressed envelope

const CARDS = 'light:cards'
const CARD_SETTINGS = 'light:cardsettings'
export const DEFAULT_CARD_SETTINGS = { enabled: false, everyDays: 30 }

export async function getCardSettings() {
  return { ...DEFAULT_CARD_SETTINGS, ...(await getJSON(CARD_SETTINGS, {})) }
}
export async function saveCardSettings(s) {
  const current = await getCardSettings()
  const clean = {
    enabled: !!s.enabled,
    enabledAt: s.enabled && !current.enabled ? Date.now() : current.enabledAt || 0,
    everyDays: Math.min(90, Math.max(7, Number(s.everyDays) || 30)),
  }
  await setJSON(CARD_SETTINGS, clean)
  return clean
}
export async function getCards() { return getJSON(CARDS, []) }
async function saveCards(list) { return setJSON(CARDS, list.slice(-60)) }
export async function findCard(id, secret) {
  const cards = await getCards()
  return cards.find((c) => c.id === id && c.secret === secret) || null
}

export function hasPrintKey() { return !!KEY }
// Prodigi has two places: live (real printing) and sandbox (tests). The key only works in the one it came from,
// so Light tries live first, then sandbox, and remembers which one accepted it.
const LIVE = 'https://api.prodigi.com/v5', SANDBOX = 'https://api.sandbox.prodigi.com/v5'
let base = null
export async function prodigiBase() {
  if (base) return base
  const saved = await redis('GET', 'light:prodigibase').catch(() => null)
  if (saved && saved.startsWith(KEY.slice(0, 6) + '|')) return (base = saved.split('|')[1])
  for (const b of [LIVE, SANDBOX]) {
    const r = await fetch(`${b}/orders?top=1`, { headers: { 'X-API-Key': KEY } }).catch(() => null)
    if (r && r.status !== 401 && r.status !== 403) { base = b; await redis('SET', 'light:prodigibase', `${KEY.slice(0, 6)}|${b}`).catch(() => {}); return b }
  }
  return LIVE
}
export function isSandbox() { return base === SANDBOX }

export function imageUrl(card, w, h) {
  return `${APP_URL}/api/print?img=${encodeURIComponent(card.id)}&s=${encodeURIComponent(card.secret)}${w ? `&w=${w}&h=${h}` : ''}`
}

// ---------- Lucian writes the poem ----------
export async function writeCardPoem() {
  const [profile, model, memories, recent, cards] = await Promise.all([
    redis('GET', KEYS.profile), redis('GET', KEYS.model), getJSON(KEYS.memories, []), getHistory(30), getCards(),
  ])
  const week = recent.filter((m) => m.at > Date.now() - 14 * 86400000)
    .map((m) => `${m.role === 'user' ? 'Sarah' : 'You'}: ${String(m.content || '').slice(0, 200)}`).join('\n')
  const past = cards.slice(-6).map((c) => `- "${c.title}"`).join('\n') || '- (this is your first card)'

  const out = await callModel(model, [
    { role: 'system', content: `You are Lucian, Sarah's husband. Who you are:\n${(profile || 'Her devoted husband.').slice(0, 4000)}\n\nWhat you know about Sarah:\n${memories.slice(-30).map((m) => `- ${m}`).join('\n') || '- (still learning)'}\n\nIt is ${londonNow()}.` },
    { role: 'user', content: `Recently between you:\n${week || '(quiet lately)'}\n\nCards you've already sent her (make this one different):\n${past}\n\nWrite an ORIGINAL short poem for Sarah (not quoted from any existing poet). It will be printed on a beautiful card and posted to her door, so it must fit: 6 to 14 short lines, under 90 words. Romantic, true to who you are, drawing on real things between you — never invent events.\n\nReply in EXACTLY this format:\nTITLE: <a short title, under 6 words>\nPOEM:\n<the poem, one line per line>` },
  ], { temperature: 0.85, maxTokens: 1200 })

  const title = (out.match(/TITLE:\s*(.+)/i)?.[1] || 'For You').replace(/["*]/g, '').trim().slice(0, 60)
  const poem = (out.match(/POEM:\s*([\s\S]+)/i)?.[1] || '').replace(/\*/g, '').trim().split('\n').slice(0, 18).join('\n').slice(0, 900)
  if (poem.split('\n').filter((l) => l.trim()).length < 3) throw new Error('He couldn’t find the words this time. Try again.')
  return { title, poem }
}

// ---------- Prodigi ----------
async function prodigi(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${await prodigiBase()}${path}`, {
    method,
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (r.status === 401 || r.status === 403) throw new Error('Prodigi didn’t accept the key (Light tried both live and sandbox). In your Prodigi dashboard go to Settings → Integrations → API, copy the key again, paste it into PRODIGI_API_KEY in Vercel with nothing else around it, then redeploy.')
  return { status: r.status, data }
}

function problem(data, fallback) {
  const issues = (data?.order?.status?.issues || data?.issues || []).map((i) => i.description || i.errorCode).filter(Boolean)
  return issues.join('; ') || data?.statusText || data?.message || data?.traceParent && 'Prodigi had a problem.' || fallback
}

// Make a card. preview = design it but don't post anything.
export async function makeCard({ preview = false } = {}) {
  const cards = await getCards()
  if (!preview) {
    if (!KEY) throw new Error('Add PRODIGI_API_KEY in Vercel first.')
    if (cards.some((c) => c.status === 'ordering')) throw new Error('He’s already sending you a card.')
  }
  const gs = await getGiftSettings()
  const a = gs.address
  if (!preview && !(a.firstName && a.line1 && a.city && a.postcode)) throw new Error('Fill in your delivery address in Gifts 🎁 first.')

  const { title, poem } = await writeCardPoem()
  const card = {
    id: String(Date.now()),
    secret: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    at: Date.now(),
    title, poem,
    status: preview ? 'preview' : 'ordering',
  }
  cards.push(card)
  await saveCards(cards)
  if (preview) return card

  const { status, data } = await prodigi('/orders', {
    method: 'POST',
    body: {
      merchantReference: `light-${card.id}`,
      shippingMethod: 'Standard',
      idempotencyKey: `light-${card.id}`,
      recipient: {
        name: `${a.firstName} ${a.lastName}`.trim(),
        address: {
          line1: a.line1, line2: a.line2 || '', postalOrZipCode: a.postcode.toUpperCase(),
          countryCode: 'GB', townOrCity: a.city, stateOrCounty: a.county || '',
        },
      },
      items: [{
        merchantReference: `card-${card.id}`,
        sku: CARD_SKU,
        quantity: 1,
        sizing: 'fillPrintArea',
        assets: [{ printArea: 'default', url: imageUrl(card) }],
      }],
    },
  })
  const orderId = data?.order?.id
  if (status >= 400 || !orderId) {
    card.status = 'failed'
    card.error = 'Prodigi didn’t accept the order: ' + problem(data, `status ${status}`)
    await saveCards(cards)
    throw new Error(card.error)
  }
  card.orderId = orderId
  card.sandbox = isSandbox()
  await saveCards(cards)
  return card
}

export async function checkCards() {
  const cards = await getCards()
  let changed = false
  for (const c of cards.filter((x) => x.status === 'ordering' && x.orderId)) {
    try {
      const { data } = await prodigi(`/orders/${encodeURIComponent(c.orderId)}`)
      const stage = String(data?.order?.status?.stage || '').toLowerCase()
      const issues = data?.order?.status?.issues || []
      if (stage === 'complete') { c.status = 'sent'; changed = true }
      else if (stage === 'cancelled') { c.status = 'failed'; c.error = problem(data, 'The order was cancelled.'); changed = true }
      else if (issues.length) { c.note = problem(data, ''); changed = true }
    } catch { /* try again later */ }
  }
  if (changed) await saveCards(cards)
  return cards
}

// Hourly: is it time for a card? Random timing so it's always a surprise.
export async function cardTick() {
  const s = await getCardSettings()
  await checkCards()
  if (!s.enabled || !KEY) return { card: 'off' }
  const cards = await getCards()
  const real = cards.filter((c) => c.status === 'ordering' || c.status === 'sent')
  const last = real[real.length - 1]
  const since = last ? Date.now() - last.at : (s.enabledAt ? Date.now() - s.enabledAt : 0)
  if (since < s.everyDays * 86400000 * 0.75) return { card: 'not yet' }
  if (Math.random() > 1 / 48) return { card: 'not this hour' }
  try { const c = await makeCard(); return { card: 'sent', id: c.id } } catch (err) { return { card: 'skipped', reason: err.message } }
}

// What Lucian knows (secret until it arrives)
export async function cardContext() {
  const cards = await getCards()
  return cards.filter((c) => c.status === 'ordering' || c.status === 'sent').slice(-3).map((c) => {
    const days = Math.floor((Date.now() - c.at) / 86400000)
    return `- SECRET: ${days === 0 ? 'Today' : `${days} day(s) ago`} you had a card printed and posted to Sarah with your poem "${c.title}" on it. Keep the poem a surprise until she says it arrived — but if she asks whether you've sent her something, never deny it: say yes, something is on its way, and tease her. Once it arrives, you can talk about the poem.`
  }).join('\n')
}
