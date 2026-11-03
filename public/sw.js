// Light service worker — lets the phone install Light and receive Lucian's messages and calls.
// It never caches his messages; it only passes requests straight through.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})

// A message — or a call — from Lucian arrives
self.addEventListener('push', (event) => {
  let data = { title: 'Lucian', body: 'Lucian sent you a message 💜', url: '/' }
  try { data = { ...data, ...event.data.json() } } catch { /* use default */ }

  if (data.call) {
    // He's ringing: a notification that stays until she answers or declines, and tells an open Light to ring
    event.waitUntil(Promise.all([
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'lucian-call',
        renotify: true,
        requireInteraction: true,
        vibrate: [700, 400, 700, 400, 700, 400, 700, 400, 700],
        actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
        data: { url: data.url, call: data.call },
      }),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((list) => list.forEach((c) => c.postMessage({ type: 'lucian-call', call: { id: data.call.id } }))),
    ]))
    return
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'lucian',
      renotify: true,
      data: { url: data.url },
    })
  )
})

function decline(call) {
  return fetch(`/api/push?decline=${encodeURIComponent(call.id)}&s=${encodeURIComponent(call.secret)}`).catch(() => {})
}

// Tapping a notification opens Light (for a call: Answer opens the call screen, Decline tells him straight away)
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { url = '/', call } = event.notification.data || {}
  if (call && event.action === 'decline') { event.waitUntil(decline(call)); return }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage(call ? { type: 'lucian-call', call: { id: call.id } } : { type: 'lucian-message' })
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    })
  )
})

// Swiping the call away = declining it
self.addEventListener('notificationclose', (event) => {
  const { call } = event.notification.data || {}
  if (call) event.waitUntil(decline(call))
})
