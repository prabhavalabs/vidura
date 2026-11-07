// Vidura's service worker: a fast, offline-capable app shell, notifications
// and the app icon's unread badge.
//
// Caching only ever covers this site's own files. API calls go to another
// origin (api-vidura…) and are never touched, so nobody's videos, chats or
// account data end up in a cache.
//
// The build (vite.config.ts) fills in BUILD and PRECACHE. In development
// they stay as placeholders and nothing is cached, so Vite's hot reload
// works as usual.
const BUILD = "__VIDURA_BUILD__"
const PRECACHE = /*__VIDURA_PRECACHE__*/ []

const CACHING = !BUILD.startsWith("__")
const SHELL_CACHE = "vidura-shell-" + BUILD
const ASSET_CACHE = "vidura-assets" // hashed names, so one cache across builds
const SHELL_URL = "/"
// How long a page load waits for the network before opening the saved copy.
const NETWORK_TIMEOUT_MS = 4000

// The API's origin, passed by the page when it registers this worker.
const API = new URL(self.location.href).searchParams.get("api") || ""

self.addEventListener("install", (event) => {
  if (!CACHING) {
    self.skipWaiting()
    return
  }
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE)
      await shell.add(new Request(SHELL_URL, { cache: "reload" }))
      const assets = await caches.open(ASSET_CACHE)
      await assets.addAll(PRECACHE)
      // The first install takes over straight away. An update waits until
      // the page asks for it (the "new version" toast), so a running page
      // never has its files swapped underneath it.
      if (!self.registration.active) await self.skipWaiting()
    })()
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE])
      const names = await caches.keys()
      // v1 of the app kept a copy of the old site under other cache names;
      // when one is found the open pages are reloaded onto the current site.
      const hadOldSite = names.some((name) => !name.startsWith("vidura-"))
      await Promise.all(
        names.filter((name) => !keep.has(name)).map((name) => caches.delete(name))
      )
      if (CACHING) await pruneAssets()
      await self.clients.claim()
      if (hadOldSite) {
        const windows = await self.clients.matchAll({ type: "window" })
        windows.forEach((client) => client.navigate(client.url))
      }
    })()
  )
})

// Hashed files from older builds pile up in the asset cache; keep this
// build's and the 200 most recently added others (chunks a still-open old
// page may lazy-load).
async function pruneAssets() {
  const cache = await caches.open(ASSET_CACHE)
  const current = new Set(PRECACHE.map((path) => new URL(path, self.location.origin).href))
  const others = (await cache.keys()).filter((request) => !current.has(request.url))
  const excess = others.length - 200
  for (let i = 0; i < excess; i++) await cache.delete(others[i])
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "vidura:skip-waiting") self.skipWaiting()
})

// --- caching ----------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  if (!CACHING) return
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === "navigate") {
    event.respondWith(page(request))
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(asset(request))
  } else if (/\.(png|svg|webmanifest|ico)$/.test(url.pathname)) {
    event.respondWith(freshOrSaved(request))
  }
})

// Pages: the network first, so a deploy is live on the next visit; the
// saved app shell when offline or when the network is too slow. Every route
// is the same index.html, so one copy serves them all.
async function page(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS)
    const type = response.headers.get("Content-Type") || ""
    if (response.ok && type.includes("text/html")) {
      await cache.put(SHELL_URL, response.clone())
    }
    return response
  } catch {
    const saved = await cache.match(SHELL_URL)
    return saved || Response.error()
  }
}

// Hashed files never change: the saved copy if there is one.
async function asset(request) {
  const cache = await caches.open(ASSET_CACHE)
  const saved = await cache.match(request)
  if (saved) return saved
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

// Icons and the manifest: fresh when online, saved for offline.
async function freshOrSaved(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch {
    return (await cache.match(request)) || Response.error()
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// --- notifications ----------------------------------------------------------

// The app icon's badge: the unread count, or nothing.
async function setBadge(count) {
  if (!("setAppBadge" in self.navigator)) return
  try {
    if (count > 0) await self.navigator.setAppBadge(count)
    else await self.navigator.clearAppBadge()
  } catch {
    // Not allowed here (no notification permission, or not installed).
  }
}

function safePath(value) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
    ? value
    : "/"
}

// A notification from the server:
// { id, kind, title, body, url, tag, unread, force }.
self.addEventListener("push", (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    message = { body: event.data ? event.data.text() : "" }
  }
  event.waitUntil(showPush(message))
})

async function showPush(message) {
  const url = safePath(message.url)
  if (Number.isInteger(message.unread)) await setBadge(message.unread)

  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  })
  // Every open page refreshes its bell; one on screen shows a toast.
  windows.forEach((client) =>
    client.postMessage({ type: "vidura:notification", notification: message })
  )
  const onScreen = windows.some(
    (client) => client.visibilityState === "visible" && client.focused
  )

  const title = message.title || "Vidura"
  const options = {
    body: message.body || "",
    tag: message.tag || undefined,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: { url, id: message.id || "" },
  }

  if (onScreen && !message.force) {
    // The server normally doesn't push to an app that's on screen; this is
    // the brief race where it did. The page's toast is enough, but Safari
    // revokes push for sites whose pushes show no notification, so one is
    // shown silently and closed at once.
    const tag = "vidura-on-screen"
    await self.registration.showNotification(title, {
      ...options,
      tag,
      silent: true,
    })
    const shown = await self.registration.getNotifications({ tag })
    shown.forEach((notification) => notification.close())
    return
  }
  await self.registration.showNotification(title, options)
}

// Tapping a notification opens its page: in an open Vidura window if there
// is one (the page routes there itself, without reloading), otherwise in a
// new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const path = safePath(data.url)
  const target = new URL(path, self.location.origin)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      const ours = windows.filter(
        (client) => new URL(client.url).origin === target.origin
      )
      // Prefer the window the person last looked at.
      const client =
        ours.find((c) => c.focused) ||
        ours.find((c) => c.visibilityState === "visible") ||
        ours[0]
      if (client) {
        client.postMessage({ type: "vidura:open", url: path, id: data.id })
        await client.focus().catch(() => {})
        return
      }
      await self.clients.openWindow(target.href)
    })()
  )
})

// The browser replaced this device's push subscription (keys rotated, or it
// expired). Subscribe again and tell the server, so notifications keep
// arriving without a visit to Settings.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event.oldSubscription, event.newSubscription))
})

async function resubscribe(oldSubscription, newSubscription) {
  if (!API) return
  try {
    let subscription = newSubscription
    if (!subscription) {
      let key = oldSubscription?.options?.applicationServerKey
      if (!key) {
        const response = await fetch(API + "/api/push/key", {
          credentials: "include",
        })
        if (!response.ok) return
        key = keyBytes((await response.json()).publicKey)
      }
      subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      })
    }
    await fetch(API + "/api/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    })
    if (oldSubscription && oldSubscription.endpoint !== subscription.endpoint) {
      await fetch(API + "/api/push/unsubscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: oldSubscription.endpoint }),
      })
    }
  } catch {
    // Signed out, or offline: Settings offers to turn notifications on again.
  }
}

function keyBytes(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/")
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}
