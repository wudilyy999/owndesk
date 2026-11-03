// OwnDesk service worker: makes the app installable and shows a friendly page when the server
// cannot be reached. It never stores pages, API answers or chat messages: they are private and
// must always come from the server.
const OFFLINE = "/offline.html"
const CACHE = "owndesk-shell-v1"
const SHELL = [OFFLINE, "/icons/icon-192.png"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  // Only page loads fall back to the offline page; everything else goes straight to the network
  if (request.mode !== "navigate") return
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)))
})
