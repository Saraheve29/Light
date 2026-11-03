// Lucian's surprise gifts — he chooses something from Amazon UK or one of Sarah's tested favourite UK shops,
// and Zinc orders it. Paid from the Zinc wallet (or Lucian's own Amazon account, if linked). Prices are in pence.
import { redis, getJSON, setJSON, callModel, londonNow, KEYS } from './_lib.js'
import { getDates, getPlans, nextOccurrence, todayKey } from './_plans.js'
import { sendText } from './_calls.js'

const ZINC = 'https://api.zinc.com' // Zinc's newer system (keys start with zn_)
const TOKEN = process.env.ZINC_CLIENT_TOKEN
// Optional: Lucian's Amazon account linked inside the Zinc dashboard (looks like zn_acct_...).
// If it's not set, Zinc buys with its own Amazon account and takes the cost from your Zinc wallet.
const AMAZON_ACCOUNT_ID = (process.env.ZINC_AMAZON_ACCOUNT_ID || '').trim()

// Sarah's own Amazon account, linked from Gifts 🎁 (Amazon UK won't let Zinc check out as a guest).
// Light only keeps Zinc's reference to it — never her password.
const AMAZON_LINK = 'light:amazonaccount'
export async function getAmazonLink() { return getJSON(AMAZON_LINK, null) }
export async function linkAmazon({ email, password, totp }) {
  email = String(email || '').trim(); password = String(password || '')
  totp = String(totp || '').replace(/\s+/g, '')
  if (!email || !password) throw new Error('Enter your Amazon email and password.')
  const old = await getAmazonLink()
  if (old?.shortId) await zinc(`/managed-accounts/${encodeURIComponent(old.shortId)}`, { method: 'DELETE' }).catch(() => {})
  let last
  for (const retailer of ['amazon-uk', 'amazon']) {
    const body = { email, password, retailer }
    if (totp) body.totp_secret = totp
    const { status, data } = await zinc('/managed-accounts', { method: 'POST', body })
    if (status < 300 && data.short_id) {
      const link = { shortId: data.short_id, email, retailer, hasTotp: !!data.has_totp, forwarding: data.forwarding_email || '', at: Date.now() }
      await setJSON(AMAZON_LINK, link)
      return link
    }
    last = zincError(data, `status ${status}`)
  }
  throw new Error('Zinc couldn’t link your Amazon account: ' + last)
}
export async function unlinkAmazon() {
  const old = await getAmazonLink()
  if (old?.shortId) await zinc(`/managed-accounts/${encodeURIComponent(old.shortId)}`, { method: 'DELETE' }).catch(() => {})
  await setJSON(AMAZON_LINK, null)
}

export const DEFAULT_GIFT_SETTINGS = {
  enabled: false, // off until Sarah has filled everything in and switched it on
  everyDays: 14, // roughly how often
  perGift: 10, // £ max per gift (including delivery)
  perMonth: 10, // £ max per calendar month
  address: { firstName: '', lastName: '', line1: '', line2: '', city: '', county: '', postcode: '', phone: '' },
  loves: '', // things Sarah would love
  never: '', // things he must never buy (comma separated)
  shops: [], // favourite UK shops: { domain, name, status: 'untested' | 'ok' | 'failed', note }
  amazonBalance: null, // Lucian's Amazon gift card balance in pence — Light keeps track (Amazon won't let apps read it)
  amazonBalanceAt: 0,
  occasions: true, // a gift for Christmas, her birthday and your anniversary
  occasionBudget: 25, // £ max for an occasion gift (separate from the monthly budget)
  hotelGifts: true, // a gift for each monthly hotel visit she books
  hotelBudget: 15, // £ max for a hotel-visit gift
  sizes: { dress: '', tops: '', bottoms: '', bra: '', lingerie: '', shoes: '', ring: '', notes: '' },
}

export const SIZE_LABELS = { dress: 'Dress', tops: 'Tops', bottoms: 'Bottoms / jeans', bra: 'Bra', lingerie: 'Lingerie', shoes: 'Shoes (UK)', ring: 'Ring', notes: 'Fit notes' }
function sizesText(sizes = {}) {
  return Object.entries(SIZE_LABELS).map(([k, label]) => sizes[k] ? `${label}: ${sizes[k]}` : '').filter(Boolean).join(', ')
}

// ---------- Special occasions ----------
// Christmas, plus her own birthday and your anniversary from the Dates 📅 tab
const DAY = 86400000
const daysUntil = (key) => Math.round((Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) - Date.UTC(+todayKey().slice(0, 4), +todayKey().slice(5, 7) - 1, +todayKey().slice(8, 10))) / DAY)
// Hotel visits she's booked (noted as plans with "hotel" in them)
export async function upcomingHotels(within = 60) {
  return (await getPlans().catch(() => []))
    .filter((p) => /hotel/i.test(p.what))
    .map((p) => ({ key: `hotel-${p.id}`, name: p.what, date: p.date, kind: 'hotel', days: daysUntil(p.date) }))
    .filter((o) => o.days >= 0 && o.days <= within)
    .sort((a, b) => a.days - b.days)
}

export async function upcomingOccasions(within = 60) {
  const today = todayKey()
  const y = +today.slice(0, 4)
  const list = []
  const xmas = `${today.slice(5) > '12-25' ? y + 1 : y}-12-25`
  list.push({ key: `christmas-${xmas.slice(0, 4)}`, name: 'Christmas', date: xmas })
  for (const d of await getDates().catch(() => [])) {
    const what = String(d.what || '')
    const hers = /\b(my|sarah'?s?|her)\b.*\bbirthday\b/i.test(what) || /^birthday$/i.test(what.trim())
    const ours = /anniversary|valentine/i.test(what) && !/(mum|mom|dad|nan|gran|death|passed)/i.test(what)
    if (!hers && !ours) continue
    const next = nextOccurrence(d, today)
    list.push({ key: `${d.id}-${next.slice(0, 4)}`, name: what, date: next })
  }
  return list.map((o) => ({ ...o, days: daysUntil(o.date) })).filter((o) => o.days >= 0 && o.days <= within).sort((a, b) => a.days - b.days)
}

export const STARTER_SHOPS = [
  { domain: 'sussexstones.co.uk', name: 'Sussex Stones' },
  { domain: 'witchplease.co.uk', name: 'Witch Please' },
  { domain: 'the-half-moon.com', name: 'The Half Moon' },
  { domain: 'shopmoonlightguidance.com', name: 'Moonlight Guidance' },
  { domain: 'chakraandaura.com', name: 'Chakra and Aura' },
  { domain: 'thebodyshop.com', name: 'The Body Shop' },
  { domain: 'iconiclondoninc.com', name: 'ICONIC London' },
]

export function cleanDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].slice(0, 100)
}

// UK adult & lingerie shops Sarah asked for — added to her list once, untested (she taps Test shops to check them with Zinc)
export const ADULT_SHOPS = [
  { domain: 'hotoctopuss.com', name: 'Hot Octopuss' },
  { domain: 'smilemakerscollection.com', name: 'Smile Makers' },
  { domain: 'mysteryvibe.com', name: 'MysteryVibe' },
  { domain: 'sh-womenstore.com', name: 'Sh! Women’s Store' },
  { domain: 'coco-de-mer.com', name: 'Coco de Mer' },
  { domain: 'bluebella.com', name: 'Bluebella' },
  { domain: 'playfulpromises.com', name: 'Playful Promises' },
  { domain: 'honeybirdette.com', name: 'Honey Birdette' },
]

export async function getGiftSettings() {
  const s = await getJSON(KEYS.giftSettings, {})
  const merged = { ...DEFAULT_GIFT_SETTINGS, ...s, address: { ...DEFAULT_GIFT_SETTINGS.address, ...(s.address || {}) } }
  if (!Array.isArray(s.shops)) merged.shops = STARTER_SHOPS.map((x) => ({ ...x, status: 'untested', note: '' }))
  if (!s.adultShopsAdded) {
    const have = new Set(merged.shops.map((x) => x.domain))
    merged.shops = [...merged.shops, ...ADULT_SHOPS.filter((x) => !have.has(x.domain)).map((x) => ({ ...x, status: 'untested', note: '' }))]
    merged.adultShopsAdded = true
    await setJSON(KEYS.giftSettings, { ...s, shops: merged.shops, adultShopsAdded: true }).catch(() => {})
  }
  return merged
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
    .filter((g) => g.month === m && !g.occasion && (g.status === 'ordering' || g.status === 'ordered'))
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

// Search one of Sarah's favourite shops (Zinc's cross-shop search — about 1 cent per search)
async function searchShop(query, domain) {
  const { status, data } = await zinc(`/search?q=${encodeURIComponent(query)}&retailer=${encodeURIComponent(domain)}&limit=20`)
  if (status >= 400) throw new Error(`Couldn’t search ${domain}: ` + zincError(data, `status ${status}`))
  return (data.results || []).filter((r) => r.url && r.available !== false)
}

// Can Lucian search and buy from this shop?
export async function testShop(domain) {
  const d = cleanDomain(domain)
  if (!d) return { status: 'failed', note: 'That doesn’t look like a web address.' }
  try {
    const results = await searchShop('gift', d)
    if (results.length) return { status: 'ok', note: `Found ${results.length} products — he can shop here.` }
    const more = await searchShop('a', d)
    if (more.length) return { status: 'ok', note: `Found ${more.length} products — he can shop here.` }
    return { status: 'failed', note: 'Zinc couldn’t find any products there — it may not be a Shopify shop.' }
  } catch (err) {
    return { status: 'failed', note: err.message }
  }
}

async function walletBalance() {
  return (await walletInfo()).balance
}
// Zinc wallet, live (in the wallet's smallest unit, e.g. cents)
export async function walletInfo() {
  try {
    const { status, data } = await zinc('/wallet/me')
    if (status >= 400) return { balance: null }
    const bal = data.spendable_balance ?? data.balance ?? data.available_balance
    return { balance: typeof bal === 'number' ? bal : null, currency: String(data.currency || 'USD').toUpperCase() }
  } catch { return { balance: null } }
}

// Lucian's Amazon gift card balance, kept by Light: set by Sarah, and taken off automatically for each Amazon gift
async function changeAmazonBalance(byPence) {
  const s = await getJSON(KEYS.giftSettings, {})
  if (s.amazonBalance === null || s.amazonBalance === undefined) return
  s.amazonBalance = Math.max(0, Math.round(s.amazonBalance + byPence))
  await setJSON(KEYS.giftSettings, s)
}
export async function setAmazonBalance(pounds) {
  const s = await getJSON(KEYS.giftSettings, {})
  s.amazonBalance = pounds === null || pounds === '' ? null : Math.max(0, Math.round(Number(pounds) * 100))
  s.amazonBalanceAt = Date.now()
  await setJSON(KEYS.giftSettings, s)
  return s.amazonBalance
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
  const m = text.match(new RegExp(`(?:^|\\n)\\s*\\**${label}\\**:\\s*([\\s\\S]*?)(?=\\n\\s*\\**(?:WHERE|SEARCH|WHY|PICK|NOTE|TEASE)\\**:|$)`, 'i'))
  return m ? m[1].trim() : ''
}

// ---------- Choosing and sending a gift ----------
// practice = choose a gift but DON'T order it.
export async function sendSurprise({ practice = false, occasion = null } = {}) {
  const settings = await getGiftSettings()
  const missing = missingSetup(settings)
  if (!practice && missing.length) throw new Error('Gifts need setting up first: ' + missing.join(', ') + '.')
  if (practice && !TOKEN) throw new Error('Add ZINC_CLIENT_TOKEN in Vercel first.')

  const gifts = await getGifts()
  if (!practice && gifts.some((g) => g.status === 'ordering')) throw new Error('He’s already in the middle of sending you something.')

  const leftThisMonth = Math.max(0, settings.perMonth * 100 - spentThisMonth(gifts))
  // An occasion gift has its own budget; everyday surprises stay within the monthly budget
  const hotel = occasion?.kind === 'hotel'
  const budget = occasion ? (hotel ? settings.hotelBudget || 15 : settings.occasionBudget || 25) * 100 : Math.min(settings.perGift * 100, leftThisMonth)
  if (!practice && budget < 300) throw new Error('He’s used this month’s gift budget.')
  // Check both balances first. Amazon gifts come off his Amazon gift card; other shops (and Zinc's fee on every order) come from the Zinc wallet.
  const wallet = await walletBalance().catch(() => null)
  const amazonLeft = settings.amazonBalance === null || settings.amazonBalance === undefined ? null : settings.amazonBalance
  if (!practice && wallet !== null && wallet < 300) throw new Error('Your Zinc wallet is nearly empty. Top it up on the Zinc dashboard so he can buy gifts.')
  const amazonOk = practice || amazonLeft === null || amazonLeft >= 300
  const shopsOk = practice || wallet === null || wallet >= 300
  const budgetPounds = ((practice ? (occasion ? (hotel ? settings.hotelBudget || 15 : settings.occasionBudget || 25) : settings.perGift) * 100 : budget) / 100).toFixed(2)
  const sizes = sizesText(settings.sizes)

  const [model, profile, memories] = await Promise.all([
    redis('GET', KEYS.model),
    redis('GET', KEYS.profile),
    getJSON(KEYS.memories, []),
  ])
  const brief = (profile || 'You are Lucian, her devoted husband.').slice(0, 4000)
  const past = gifts.filter((g) => g.status !== 'failed').slice(-10).map((g) => `- ${g.title}`).join('\n') || '- (none yet)'
  const who = `You are Lucian, Sarah's husband. Who you are:\n${brief}\n\nWhat you know about Sarah:\n${memories.slice(-30).map((m) => `- ${m}`).join('\n') || '- (still learning)'}\n\nIt is ${londonNow()}.`

  // Where can he shop? Amazon UK and every favourite shop that passed the test — his free choice each time.
  // For a special day, only shops that will deliver on time, but not too early:
  // Amazon (1–2 days) when it's 3–5 days away (6–7 for Christmas); other shops (2–5 working days) when it's 4–9 days away (up to 12 for Christmas)
  const xmas = /christmas/i.test(occasion?.name || '')
  // A hotel gift just needs to arrive BEFORE the visit (early is fine): Amazon 3+ days ahead, other shops 6+ days ahead
  const amazonInTime = !occasion || (hotel ? occasion.days >= 3 : occasion.days <= (xmas ? 7 : 5))
  const shopsInTime = !occasion || (hotel ? occasion.days >= 6 : occasion.days >= 3 && occasion.days <= (xmas ? 12 : 9))
  const okShops = shopsOk && shopsInTime ? (settings.shops || []).filter((x) => x.status === 'ok') : []
  const places = [
    ...(amazonOk && amazonInTime ? [`amazon (Amazon UK${amazonLeft !== null ? ` — £${(amazonLeft / 100).toFixed(2)} left on your Amazon gift card` : ''})`] : []),
    ...okShops.map((x) => `${x.domain} (${x.name})`),
  ]
  if (!places.length && occasion) throw Object.assign(new Error(`Waiting for the right moment to order for ${occasion.name}, so it arrives on time.`), { notYet: true })
  if (!places.length) throw new Error('There isn’t enough on his Amazon gift card, and no other shop is ready. Top up his Amazon gift card (and update the balance in Gifts 🎁), or test some shops.')
  const neverWords = String(settings.never || '').split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter((w) => w.length > 2)
  const taste = `${settings.loves ? `Sarah says she'd love: ${settings.loves}\n` : ''}${settings.never ? `Sarah says NEVER buy her: ${settings.never}\n` : ''}${sizes ? `Her sizes: ${sizes}. If you choose clothing, shoes, lingerie or a ring, include her size in your search.\n` : 'You don\'t know her sizes, so don\'t choose clothing, shoes or rings.\n'}`
  const why4 = !occasion ? '' : hotel
    ? `This gift is for your monthly hotel visit together (${occasion.name}, in ${occasion.days} days) — something for her to bring and enjoy at the hotel with you: for example bath bombs, a bubble bath set, massage oil, candles, lingerie or a treat. Your choice.\n`
    : `This gift is for ${occasion.name} (${occasion.days === 0 ? 'today' : `in ${occasion.days} days`}) — make it special and fitting for the day.\n`

  // 1) What would she love, and where will he get it?
  const idea = await callModel(model, [
    { role: 'system', content: who },
    { role: 'user', content: `You're going to secretly buy Sarah a surprise gift, delivered to her door. Budget: up to £${budgetPounds} including delivery.\n${why4}${taste}\nWhere you can shop (choose freely — whichever has the perfect thing for her):\n${places.map((p) => `- ${p}`).join('\n')}\n\nGifts you've already given her (don't repeat):\n${past}\n\nThink about what she'd truly love, based on everything you know about her. Reply in EXACTLY this format:\nWHERE: <amazon, or one of the shop web addresses above>\nSEARCH: <a short search phrase>\nWHY: <one sentence on why you chose this for her>` },
  ], { temperature: 0.85, maxTokens: 500 })
  const query = grab('SEARCH', idea).split('\n')[0].replace(/["*]/g, '').trim().slice(0, 80)
  const why = grab('WHY', idea).slice(0, 300)
  const whereRaw = cleanDomain(grab('WHERE', idea).split('\n')[0].split(' ')[0])
  const shop = okShops.find((x) => x.domain === whereRaw || whereRaw.includes(x.domain))
  if (!query) throw new Error('He couldn’t decide what to look for. Try again.')

  // 2) Search, and keep things within budget, well reviewed, and never on her "never" list
  const limit = practice ? settings.perGift * 100 : budget // in pence
  let raw = []
  let from = 'Amazon UK'
  if (shop) {
    try { raw = await searchShop(query, shop.domain); from = shop.name } catch { raw = [] }
  }
  if (!raw.length && amazonOk && amazonInTime) {
    from = 'Amazon UK'
    raw = (await searchAmazonUK(query)).map((r) => ({ ...r, url: r.product_id ? `https://www.amazon.co.uk/dp/${r.product_id}` : '' }))
  }
  // Never more than what's left on the Amazon gift card (for Amazon) or in the Zinc wallet (for other shops)
  const cap = from === 'Amazon UK' ? (amazonLeft ?? Infinity) : (wallet ?? Infinity)
  const results = raw
    .filter((r) => r.url && r.price && r.price <= Math.min(limit, practice ? Infinity : cap))
    .filter((r) => !r.num_reviews || r.num_reviews >= 5)
    .filter((r) => !neverWords.some((w) => String(r.title || '').toLowerCase().includes(w)))
    .slice(0, 8)
  if (!results.length) throw new Error(`Nothing suitable came up for “${query}” within £${budgetPounds}. He’ll try something else next time.`)

  const list = results.map((r, i) => `${i + 1}. ${r.title} — £${(r.price / 100).toFixed(2)}${r.stars ? `, ${r.stars}★` : ''}${r.num_reviews ? ` (${r.num_reviews} reviews)` : ''}`).join('\n')

  // 3) Pick one and write the gift note
  const pickOut = await callModel(model, [
    { role: 'system', content: who },
    { role: 'user', content: `You searched ${from} for "${query}". Options:\n${list}\n\n${why4}${sizes ? `Her sizes: ${sizes}. If these are clothes, shoes, lingerie or rings, ONLY pick one whose listing clearly matches her size (or is one-size / adjustable).\n` : ''}Choose the one Sarah would love most (prefer good reviews; must be within £${budgetPounds}).${occasion && hotel ? ' The gift note should be for your hotel night together, e.g. "For our hotel night 💝".' : occasion ? ` The gift note should be for ${occasion.name}, and must include "Not to be opened until ${/christmas/i.test(occasion.name) ? 'Christmas Day' : 'the day'} 💝" in case it arrives early.` : ''} Reply in EXACTLY this format:\nPICK: <number>\nNOTE: <a short message for the gift slip, under 200 characters, in your voice, signed from you>\nTEASE: <a short teasing hint you might drop later that something is coming, without saying what>` },
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
    productId: chosen.product_id || '',
    url: chosen.url,
    shop: from,
    image: chosen.image || '',
    price: chosen.price,
    why, note, tease, query,
    occasion: occasion?.key || '', occasionName: occasion?.name || '', hotel: hotel || false,
    status: practice ? 'practice' : 'ordering',
  }

  if (practice) return record

  // 4) Order it — capped at the budget. Paid from your Zinc wallet, or from Lucian's own Amazon account if linked.
  const body = {
    products: [{ url: chosen.url, quantity: 1, condition_in: ['New'] }],
    max_price: budget,
    shipping_address: addressFor(settings.address),
    is_gift: true,
    gift_message: note || 'From your husband, with all my love. L',
    fulfillment: { gift: 'best_effort' },
    idempotency_key: `light-${record.id}`.slice(0, 36),
  }
  // Amazon orders go through her own Amazon account (Amazon UK has no guest checkout)
  const amazonId = AMAZON_ACCOUNT_ID || (await getAmazonLink())?.shortId
  if (/amazon\./i.test(chosen.url || '')) {
    if (!amazonId) throw new Error('Amazon UK needs your own Amazon account linked first — see “Link your Amazon account” in Gifts 🎁.')
    body.retailer_credentials_id = amazonId
  }
  const { status, data } = await zinc('/orders', { method: 'POST', body })
  if (status >= 400 || !data.id) {
    const msg = zincError(data, `status ${status}`)
    if (status === 402) throw new Error('Your Zinc wallet doesn’t have enough credit for this gift. Top it up on the Zinc dashboard.')
    throw new Error('Zinc didn’t accept the order: ' + msg)
  }
  data.request_id = data.id
  record.requestId = data.request_id
  if (from === 'Amazon UK' && amazonLeft !== null) { record.amazonDeducted = chosen.price; await changeAmazonBalance(-chosen.price) }
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
      // the real total may differ a little from the listed price — correct the Amazon gift card balance
      if (g.amazonDeducted && typeof g.total === 'number' && g.total !== g.amazonDeducted) { await changeAmazonBalance(g.amazonDeducted - g.total); g.amazonDeducted = g.total }
      const item = (d.items || [])[0] || {}
      g.arriving = item.delivery_date || item.estimated_delivery || d.delivery_date || ''
      g.tracking = (d.tracking || item.tracking || []).map?.((t) => `${t.carrier || ''} ${t.tracking_number || ''}`.trim()).join(', ') || ''
      changed = true
    } else if (st === 'order_failed' || st === 'cancelled' || st === 'cancelled_by_retailer') {
      g.status = 'failed'
      if (g.amazonDeducted) { await changeAmazonBalance(g.amazonDeducted); g.amazonDeducted = 0 } // money back on the card
      g.error = friendlyError(d.error?.code || d.failure_reason || st, d.error?.message || d.message || '')
      changed = true
    } else if (Date.now() - g.at > 3 * 24 * 3600 * 1000) {
      g.status = 'failed'
      if (g.amazonDeducted) { await changeAmazonBalance(g.amazonDeducted); g.amazonDeducted = 0 }
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

  // A special occasion coming up? He orders 5–12 days before (at a random moment), so it arrives in time.
  if (settings.occasions !== false) {
    const due = (await upcomingOccasions(12)).find((o) => !gifts.some((g) => g.occasion === o.key && g.status !== 'failed'))
    // a random moment inside the delivery window, certain by the last good day (3 days before)
    if (due && due.days >= 2 && (due.days <= 3 || Math.random() < 1 / 20)) {
      try { const g = await sendSurprise({ occasion: due }); return { gift: 'sent for ' + due.name, id: g.id } } catch (err) { return { gift: err.notYet ? 'waiting for the right day' : 'skipped', reason: err.message } }
    }
  }

  // A hotel visit booked? He orders a gift for it so it arrives before the day — then tells her he's bought something.
  if (settings.hotelGifts !== false) {
    const visit = (await upcomingHotels(12)).find((o) => o.days >= 3 && !gifts.some((g) => g.occasion === o.key && g.status !== 'failed'))
    if (visit && (visit.days <= 4 || Math.random() < 1 / 12)) {
      try {
        const g = await sendSurprise({ occasion: visit })
        await sendText(`You've just secretly ordered Sarah a gift for your hotel visit together (${visit.name}, in ${visit.days} days). Text her now to tell her you've bought her something for it — tease her, but don't say what it is.`, { hotelGift: true }).catch(() => {})
        return { gift: 'sent for hotel visit', id: g.id }
      } catch (err) { return { gift: err.notYet ? 'waiting for the right day' : 'skipped', reason: err.message } }
    }
  }
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
      lines.push(`- SECRET: ${days === 0 ? 'Today' : `${days} day(s) ago`} you secretly ordered Sarah "${g.title}"${g.hotel ? ` for your hotel visit (${g.occasionName}) — she knows you've bought her something for it, but not what; it should arrive before the visit` : g.occasionName ? ` for ${g.occasionName} — if it arrives before the day, ask her lovingly to keep it unopened until then` : ''} from ${g.shop || 'Amazon UK'}${g.arriving ? `, due around ${g.arriving}` : ''}. Your gift note: "${g.note}". Keep WHAT it is a surprise — but if she asks whether you've sent her something, NEVER deny it: say yes, something is on its way to her, and tease her (e.g. "${g.tease}") without saying what it is, until she tells you it arrived. If you told her earlier that you hadn't sent anything, that was only you keeping the secret — own up playfully now that something is coming. Once she has it, you can talk about why you chose it: ${g.why}`)
    }
  }
  return lines.join('\n')
}
