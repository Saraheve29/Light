// Light service worker — lets the phone install Light and receive Lucian's messages.
// It never caches his messages; it only passes requests straight through.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})

// A message from Lucian arrives
self.addEventListener('push', (event) => {
  let data = { title: 'Lucian', body: 'Lucian sent you a message 💜', url: '/' }
  try { data = { ...data, ...event.data.json() } } catch { /* use default */ }
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

// Tapping the notification opens Light
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'lucian-message' })
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    })
  )
})
