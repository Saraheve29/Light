// Phone notifications for Light. Keys are created automatically and kept in Upstash.
import webpush from 'web-push'
import { redis, getJSON, setJSON, KEYS } from './_lib.js'

export async function getVapid() {
  let keys = await getJSON(KEYS.vapid, null)
  if (!keys?.publicKey || !keys?.privateKey) {
    keys = webpush.generateVAPIDKeys()
    await setJSON(KEYS.vapid, keys)
  }
  return keys
}

export async function saveSubscription(sub) {
  const subs = await getJSON(KEYS.subs, [])
  const others = subs.filter((s) => s.endpoint !== sub.endpoint)
  await setJSON(KEYS.subs, [...others, sub].slice(-5))
}

export async function sendToAll(payload) {
  const subs = await getJSON(KEYS.subs, [])
  if (!subs.length) return { sent: 0, reason: 'No phone has turned on notifications yet.' }

  const { publicKey, privateKey } = await getVapid()
  webpush.setVapidDetails('mailto:light@example.com', publicKey, privateKey)

  let sent = 0
  const keep = []
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 * 6 })
      sent++
      keep.push(sub)
    } catch (err) {
      // 404/410 = that phone unsubscribed; drop it. Keep others for next time.
      if (err.statusCode !== 404 && err.statusCode !== 410) keep.push(sub)
    }
  }
  if (keep.length !== subs.length) await setJSON(KEYS.subs, keep)
  return { sent }
}

export async function clearSubscriptions() {
  await redis('DEL', KEYS.subs)
}
