// OwnDesk service worker: makes the app installable, shows a friendly page when the server
// cannot be reached, and shows web notifications (push). It never stores pages, API answers or
// chat messages: they are private and must always come from the server.
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

// Web Push (lib/companion/push.ts). Every push must show a notification right away: Safari
// withdraws the permission from sites that receive a push and show nothing.
self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const url =
    typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/companion"
  event.waitUntil(
    self.registration.showNotification(data.title || "新消息", {
      body: data.body || "发来一条消息",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    })
  )
})

// A tap opens the chat: the window that is already open if there is one
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const target = new URL(
    event.notification.data?.url || "/companion",
    self.location.origin
  )
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windows) => {
        const open = windows.find(
          (client) => new URL(client.url).origin === target.origin
        )
        if (open) {
          await open.focus()
          if ("navigate" in open && new URL(open.url).pathname !== target.pathname)
            return open.navigate(target.href)
          return undefined
        }
        return self.clients.openWindow(target.href)
      })
  )
})
