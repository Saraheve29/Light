// Light service worker — lets the phone install Light as an app.
// It never caches his messages; it only passes requests straight through.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
