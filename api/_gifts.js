// Lucian's surprise gifts — he chooses something from Amazon UK and Zinc orders it with his own Amazon account,
// paid from that account's gift card balance. Prices from Amazon UK are in pence.
import { redis, getJSON, setJSON, callModel, londonNow, KEYS } from './_lib.js'

const ZINC = 'https://api.zinc.io/v1'
const TOKEN = process.env.ZINC_CLIENT_TOKEN
const AMAZON_EMAIL = process.env.LUCIAN_AMAZON_EMAIL
const AMAZON_PASSWORD = process.env.LUCIAN_AMAZON_PASSWORD

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
  if (!AMAZON_EMAIL) missing.push('LUCIAN_AMAZON_EMAIL in Vercel')
  if (!AMAZON_PASSWORD) missing.push('LUCIAN_AMAZON_PASSWORD in Vercel')
  const a = settings.address
  for (const [k, label] of [['firstName', 'first name'], ['lastName', 'last name'], ['line1', 'address line 1'], ['city', 'town'], ['postcode', 'postcode'], ['phone', 'phone number']]) {
    if (!String(a[k] || '').trim()) missing.push(`your ${label}`)
  }
  return missing
}

// ---------- Zinc ----------
// Zinc calls its key a "client token" (older docs) or an "API key" (newer docs).
// Try the older login style first, then the newer one, so either kind of key works.
async function zinc(path, { method = 'GET', body } = {}) {
  const key = String(TOKEN || '').trim()
  const styles = key.startsWith('zn_')
    ? ['Bearer ' + key, 'Basic ' + Buffer.from(`${key}:`).toString('base64')]
    : ['Basic ' + Buffer.from(`${key}:`).toString('base64'), 'Bearer ' + key]
  let last = { status: 0, data: {} }
  for (const auth of styles) {
    const r = await fetch(`${ZINC}${path}`, {
      method,
      headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await r.json().catch(() => ({}))
    last = { status: r.status, data }
    const authProblem = r.status === 401 || r.status === 403 || /auth|token|unauthori[sz]ed/i.test(String(data.code || data.message || ''))
    if (!authProblem) return last
  }
  if (last.status === 401 || last.status === 403) {
    throw new Error('Zinc didn’t accept the key. Check ZINC_CLIENT_TOKEN in Vercel matches the key on your Zinc dashboard.')
  }
  return last
}

async function searchAmazonUK(query) {
  for (let i = 0; i < 8; i++) {
    const { data } = await zinc(`/search?retailer=amazon_uk&query=${encodeURIComponent(query)}`)
    if (data.status === 'completed') return data.results || []
    if (data.status === 'failed' || data._type === 'error') throw new Error('Amazon search failed: ' + (data.message || data.code || 'unknown'))
    await new Promise((res) => setTimeout(res, 3000))
  }
  throw new Error('Amazon search took too long.')
}

function addressFor(a) {
  return {
    first_name: a.firstName.trim(),
    last_name: a.lastName.trim(),
    address_line1: a.line1.trim(),
    address_line2: (a.line2 || '').trim(),
    city: a.city.trim(),
    state: (a.county || a.city).trim(),
    zip_code: a.postcode.trim().toUpperCase(),
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

  // 4) Order it — Lucian's Amazon account, paid from his gift balance, capped at the budget
  const addr = addressFor(settings.address)
  const { status, data } = await zinc('/orders', {
    method: 'POST',
    body: {
      retailer: 'amazon_uk',
      products: [{
        product_id: chosen.product_id,
        quantity: 1,
        seller_selection_criteria: { condition_in: ['New'], max_item_price: budget, handling_days_max: 6 },
      }],
      max_price: budget,
      shipping_address: addr,
      billing_address: addr,
      shipping_method: 'cheapest',
      is_gift: true,
      gift_message: note || 'From your husband, with all my love. L',
      payment_method: { use_gift: true },
      retailer_credentials: { email: AMAZON_EMAIL, password: AMAZON_PASSWORD },
      client_notes: { from: 'Light', giftId: record.id },
    },
  })
  if (status >= 400 || !data.request_id) {
    throw new Error('Zinc didn’t accept the order: ' + (data.message || data.code || `status ${status}`))
  }
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
    const { data } = await zinc(`/orders/${encodeURIComponent(g.requestId)}`)
    if (data._type === 'order_response') {
      g.status = 'ordered'
      g.total = data.price_components?.total || g.price
      const d = (data.delivery_dates || [])[0]
      g.arriving = d?.date || d?.delivery_date || ''
      g.tracking = (data.tracking || []).map((t) => `${t.carrier} ${t.tracking_number}`).join(', ')
      changed = true
    } else if (data._type === 'error' && data.code && data.code !== 'request_processing') {
      g.status = 'failed'
      g.error = friendlyError(data.code, data.message)
      changed = true
    } else if (Date.now() - g.at > 2 * 24 * 3600 * 1000) {
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
    insufficient_funds: 'His Amazon gift balance was too low.',
    invalid_login_credentials: 'Amazon didn’t accept his login — check LUCIAN_AMAZON_EMAIL and LUCIAN_AMAZON_PASSWORD.',
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
