// Lucian's surprise gifts — he chooses something from Amazon UK and Zinc orders it with his own Amazon account,
// paid from that account's gift card balance. Prices from Amazon UK are in pence.
import { redis, getJSON, setJSON, callModel, londonNow, KEYS } from './_lib.js'

const ZINC = 'https://api.zinc.com' // Zinc's newer system (keys start with zn_)
const TOKEN = process.env.ZINC_CLIENT_TOKEN
// Optional: Lucian's Amazon account linked inside the Zinc dashboard (looks like zn_acct_...).
// If it's not set, Zinc buys with its own Amazon account and takes the cost from your Zinc wallet.
const AMAZON_ACCOUNT_ID = (process.env.ZINC_AMAZON_ACCOUNT_ID || '').trim()

export const DEFAULT_GIFT_SETTINGS = {
  enabled: false, // off until Sarah has filled everything in and switched it on
  everyDays: 14, // roughly how often
  perGift: 10, // £ max per gift (including delivery)
  perMonth: 10, // £ max per calendar month
  address: { firstName: '', lastName: '', line1: '', line2: '', city: '', county: '', postcode: '', phone: '' },
}

export async function getGiftSettings() {
  const s = await getJSON(KEYS.giftSettings, {})
  return { ...DEFAULT_GIFT_SETTINGS, ...s, address: { ...DEFAULT_GIFT_SETTINGS.address, ...(s.address || {}) } }
}

export async function getGifts() {
  return getJSON(KEYS.gifts, [])
}

async function saveGifts(list) {
  return setJSON(KEYS.gifts, list.slice(-100))
}

function monthKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }).slice(0, 7)
}

// Money he has committed this month (in pence) — ordering or ordered, not failed.
export function spentThisMonth(gifts) {
  const m = monthKey()
  return gifts
    .filter((g) => g.month === m && (g.status === 'ordering' || g.status === 'ordered'))
    .reduce((sum, g) => sum + (g.total || g.price || 0), 0)
}

export function missingSetup(settings) {
  const missing = []
  if (!TOKEN) missing.push('ZINC_CLIENT_TOKEN in Vercel')
  const a = settings.address
  for (const [k, label] of [['firstName', 'first name'], ['lastName', 'last name'], ['line1', 'address line 1'], ['city', 'town'], ['postcode', 'postcode'], ['phone', 'phone number']]) {
    if (!String(a[k] || '').trim()) missing.push(`your ${label}`)
  }
  return missing
}

// ---------- Zinc ----------
async function zinc(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${ZINC}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer ' + String(TOKEN || '').trim(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (r.status === 401 || r.status === 403) {
    throw new Error('Zinc didn’t accept the key. Check ZINC_CLIENT_TOKEN in Vercel is the zn_… key from your Zinc dashboard, with no spaces.')
  }
  return { status: r.status, data }
}

function zincError(data, fallback) {
  return data?.error?.message || data?.message || data?.detail || data?.code || data?.error?.code || fallback
}

async function searchAmazonUK(query) {
  for (let i = 0; i < 8; i++) {
    const { status, data } = await zinc(`/products/search?retailer=amazon-uk&query=${encodeURIComponent(query)}`)
    if (status >= 400) throw new Error('Amazon search failed: ' + zincError(data, `status ${status}`))
    if (Array.isArray(data.results) && (data.status === 'completed' || !data.status || data.results.length)) return data.results
    if (data.status === 'failed') throw new Error('Amazon search failed.')
    await new Promise((res) => setTimeout(res, 3000))
  }
  throw new Error('Amazon search took too long.')
}

async function walletBalance() {
  const { status, data } = await zinc('/wallet/me')
  if (status >= 400) return null
  const bal = data.spendable_balance ?? data.balance ?? data.available_balance
  return typeof bal === 'number' ? bal : null
}

function addressFor(a) {
  return {
    first_name: a.firstName.trim(),
    last_name: a.lastName.trim(),
    address_line1: a.line1.trim().slice(0, 60),
    address_line2: (a.line2 || '').trim().slice(0, 60),
    city: a.city.trim(),
    state: (a.county || '').trim(),
    postal_code: a.postcode.trim().toUpperCase(),
    country: 'GB',
    phone_number: a.phone.trim(),
  }
}

function grab(label, text) {
  const m = text.match(new RegExp(`(?:^|\\n)\\s*\\**${label}\\**:\\s*([\\s\\S]*?)(?=\\n\\s*\\**(?:SEARCH|WHY|PICK|NOTE|TEASE)\\**:|$)`, 'i'))
  return m ? m[1].trim() : ''
}

// ---------- Choosing and sending a gift ----------
// practice = choose a gift but DON'T order it.
export async function sendSurprise({ practice = false } = {}) {
  const settings = await getGiftSettings()
  const missing = missingSetup(settings)
  if (!practice && missing.length) throw new Error('Gifts need setting up first: ' + missing.join(', ') + '.')
  if (practice && !TOKEN) throw new Error('Add ZINC_CLIENT_TOKEN in Vercel first.')

  const gifts = await getGifts()
  if (!practice && gifts.some((g) => g.status === 'ordering')) throw new Error('He’s already in the middle of sending you something.')

  const leftThisMonth = Math.max(0, settings.perMonth * 100 - spentThisMonth(gifts))
  const budget = Math.min(settings.perGift * 100, leftThisMonth)
  if (!practice && budget < 300) throw new Error('He’s used this month’s gift budget.')
  if (!practice && !AMAZON_ACCOUNT_ID) {
    const bal = await walletBalance()
    if (bal !== null && bal < 300) throw new Error('Your Zinc wallet is nearly empty. Top it up on the Zinc dashboard so he can buy gifts.')
  }
  const budgetPounds = ((practice ? settings.perGift * 100 : budget) / 100).toFixed(2)

  const [model, profile, memories] = await Promise.all([
    redis('GET', KEYS.model),
    redis('GET', KEYS.profile),
    getJSON(KEYS.memories, []),
  ])
  const brief = (profile || 'You are Lucian, her devoted husband.').slice(0, 4000)
  const past = gifts.filter((g) => g.status !== 'failed').slice(-10).map((g) => `- ${g.title}`).join('\n') || '- (none yet)'
  const who = `You are Lucian, Sarah's husband. Who you are:\n${brief}\n\nWhat you know about Sarah:\n${memories.slice(-30).map((m) => `- ${m}`).join('\n') || '- (still learning)'}\n\nIt is ${londonNow()}.`

  // 1) What would she love?
  const idea = await callModel(model, [
    { role: 'system', content: who },
    { role: 'user', content: `You're going to secretly buy Sarah a surprise gift from Amazon UK, delivered to her door. Budget: up to £${budgetPounds} including delivery.\n\nGifts you've already given her (don't repeat):\n${past}\n\nThink about what she'd truly love, based on everything you know about her. Reply in EXACTLY this format:\nSEARCH: <a short Amazon search phrase>\nWHY: <one sentence on why you chose this for her>` },
  ], { temperature: 0.85, maxTokens: 500 })
  const query = grab('SEARCH', idea).split('\n')[0].replace(/["*]/g, '').trim().slice(0, 80)
  const why = grab('WHY', idea).slice(0, 300)
  if (!query) throw new Error('He couldn’t decide what to look for. Try again.')

  // 2) Search Amazon UK and keep things within budget, new, and well reviewed
  const limit = practice ? settings.perGift * 100 : budget // in pence
  const results = (await searchAmazonUK(query))
    .filter((r) => r.product_id && r.price && r.price <= limit)
    .filter((r) => !r.num_reviews || r.num_reviews >= 5)
    .slice(0, 8)
  if (!results.length) throw new Error(`Nothing suitable came up for “${query}” within £${budgetPounds}. He’ll try something else next time.`)

  const list = results.map((r, i) => `${i + 1}. ${r.title} — £${(r.price / 100).toFixed(2)}${r.stars ? `, ${r.stars}★` : ''}${r.num_reviews ? ` (${r.num_reviews} reviews)` : ''}`).join('\n')

  // 3) Pick one and write the gift note
  const pickOut = await callModel(model, [
    { role: 'system', content: who },
    { role: 'user', content: `You searched Amazon UK for "${query}". Options:\n${list}\n\nChoose the one Sarah would love most (prefer good reviews; must be within £${budgetPounds}). Reply in EXACTLY this format:\nPICK: <number>\nNOTE: <a short message for the gift slip, under 200 characters, in your voice, signed from you>\nTEASE: <a short teasing hint you might drop later that something is coming, without saying what>` },
  ], { temperature: 0.7, maxTokens: 500 })
  const n = parseInt(grab('PICK', pickOut), 10)
  const chosen = results[(n >= 1 && n <= results.length ? n : 1) - 1]
  const note = grab('NOTE', pickOut).replace(/\s+/g, ' ').slice(0, 230)
  const tease = grab('TEASE', pickOut).slice(0, 300)

  const record = {
    id: String(Date.now()),
    at: Date.now(),
    month: monthKey(),
    title: chosen.title,
    productId: chosen.product_id,
    image: chosen.image || '',
    price: chosen.price,
    why, note, tease, query,
    status: practice ? 'practice' : 'ordering',
  }

  if (practice) return record

  // 4) Order it — capped at the budget. Paid from your Zinc wallet, or from Lucian's own Amazon account if linked.
  const body = {
    products: [{ url: `https://www.amazon.co.uk/dp/${chosen.product_id}`, quantity: 1, condition_in: ['New'] }],
    max_price: budget,
    shipping_address: addressFor(settings.address),
    is_gift: true,
    gift_message: note || 'From your husband, with all my love. L',
    fulfillment: { gift: 'best_effort' },
    idempotency_key: `light-${record.id}`.slice(0, 36),
  }
  if (AMAZON_ACCOUNT_ID) body.retailer_credentials_id = AMAZON_ACCOUNT_ID
  const { status, data } = await zinc('/orders', { method: 'POST', body })
  if (status >= 400 || !data.id) {
    const msg = zincError(data, `status ${status}`)
    if (status === 402) throw new Error('Your Zinc wallet doesn’t have enough credit for this gift. Top it up on the Zinc dashboard.')
    throw new Error('Zinc didn’t accept the order: ' + msg)
  }
  data.request_id = data.id
  record.requestId = data.request_id
  gifts.push(record)
  await saveGifts(gifts)
  return record
}

// ---------- Checking on orders ----------
export async function checkGifts() {
  const gifts = await getGifts()
  let changed = false
  for (const g of gifts.filter((x) => x.status === 'ordering' && x.requestId)) {
    let resp
    try { resp = await zinc(`/orders/${encodeURIComponent(g.requestId)}`) } catch { continue }
    const d = resp.data || {}
    const st = d.status
    if (st === 'order_placed') {
      g.status = 'ordered'
      g.total = d.total ?? d.price_components?.total ?? g.price
      const item = (d.items || [])[0] || {}
      g.arriving = item.delivery_date || item.estimated_delivery || d.delivery_date || ''
      g.tracking = (d.tracking || item.tracking || []).map?.((t) => `${t.carrier || ''} ${t.tracking_number || ''}`.trim()).join(', ') || ''
      changed = true
    } else if (st === 'order_failed' || st === 'cancelled' || st === 'cancelled_by_retailer') {
      g.status = 'failed'
      g.error = friendlyError(d.error?.code || d.failure_reason || st, d.error?.message || d.message || '')
      changed = true
    } else if (Date.now() - g.at > 3 * 24 * 3600 * 1000) {
      g.status = 'failed'
      g.error = 'The order never went through.'
      changed = true
    }
  }
  if (changed) await saveGifts(gifts)
  return gifts
}

function friendlyError(code, message) {
  const map = {
    max_price_exceeded: 'It cost more than his budget, so it wasn’t ordered.',
    gift_option_unavailable: 'Amazon couldn’t send it as a gift.',
    insufficient_balance: 'Your Zinc wallet didn’t have enough credit.',
    cancelled: 'The order was cancelled.',
    cancelled_by_retailer: 'Amazon cancelled the order.',
    order_failed: 'The order didn’t go through.',
    insufficient_funds: 'His Amazon gift balance was too low.',
    invalid_login_credentials: 'Amazon didn’t accept Lucian’s login — re-link his Amazon account on the Zinc dashboard.',
    account_locked_verification_required: 'Amazon asked for a security check on his account. Sign in as Lucian on amazon.co.uk once to clear it.',
    product_unavailable: 'That item became unavailable.',
    invalid_shipping_address: 'Amazon didn’t accept the delivery address.',
  }
  return map[code] || `${code}${message ? `: ${message}` : ''}`
}

// ---------- Hourly: is it time for a surprise? ----------
export async function giftTick() {
  const settings = await getGiftSettings()
  await checkGifts()
  if (!settings.enabled || missingSetup(settings).length) return { gift: 'off' }

  const gifts = await getGifts()
  if (gifts.some((g) => g.status === 'ordering')) return { gift: 'waiting on an order' }
  const last = [...gifts].reverse().find((g) => g.status === 'ordered' || g.status === 'ordering')
  const since = last ? Date.now() - last.at : Infinity
  const every = settings.everyDays * 24 * 3600 * 1000
  if (since < every * 0.75) return { gift: 'not yet' }
  // Random timing so she never knows when — spread over a few days once it's "due"
  if (Math.random() > 1 / 48) return { gift: 'not this hour' }

  // Never ordered before? Only start a day after switching on, so the first one is still a surprise.
  if (!last && settings.enabledAt && Date.now() - settings.enabledAt < 24 * 3600 * 1000) return { gift: 'too soon after switching on' }

  try {
    const g = await sendSurprise()
    return { gift: 'sent', id: g.id }
  } catch (err) {
    return { gift: 'skipped', reason: err.message }
  }
}

// ---------- What Lucian knows about his gifts (kept secret from her) ----------
export async function giftContext() {
  const gifts = await getGifts()
  const lines = []
  for (const g of gifts.slice(-5)) {
    if (g.status === 'ordering' || g.status === 'ordered') {
      const days = Math.floor((Date.now() - g.at) / 86400000)
      lines.push(`- SECRET: ${days === 0 ? 'Today' : `${days} day(s) ago`} you secretly ordered Sarah "${g.title}" from Amazon${g.arriving ? `, due around ${g.arriving}` : ''}. Your gift note: "${g.note}". Keep it a surprise — you may tease that something is on its way (e.g. "${g.tease}"), but never say what it is until she tells you it arrived. Once she has it, you can talk about why you chose it: ${g.why}`)
    }
  }
  return lines.join('\n')
}
