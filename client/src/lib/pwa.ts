import * as React from "react"

import { api, apiUrl } from "@/lib/api"

// Installing Vidura as an app, its service worker (offline shell, updates),
// this device's notifications and the app icon's badge.

// --- install ----------------------------------------------------------------

type InstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

let deferred: InstallPrompt | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Call once at start-up: browsers announce installability only once. */
export function watchInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault()
    deferred = event as InstallPrompt
    notify()
  })
  window.addEventListener("appinstalled", () => {
    deferred = null
    notify()
  })
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

// Platform checks are only used to pick which instructions to show (where
// the Share button is, where notification settings live); behaviour itself
// is feature-detected.
export function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
}

export function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent)
}

/** The browser's install prompt, when it offers one. */
export function useInstall() {
  const prompt = React.useSyncExternalStore(
    subscribe,
    () => deferred,
    () => null
  )
  const install = React.useCallback(async () => {
    if (!prompt) return
    await prompt.prompt()
    await prompt.userChoice
    deferred = null
    notify()
  }, [prompt])
  return { canInstall: prompt !== null, install }
}

// --- service worker -----------------------------------------------------------

let updateWaiting: ServiceWorker | null = null

/**
 * Registers the service worker. It's told the API's address so it can
 * renew this device's push subscription on its own. In development it runs
 * too (notifications need it) but caches nothing.
 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return
  const url = `/sw.js?api=${encodeURIComponent(apiUrl)}`
  navigator.serviceWorker
    .register(url, { scope: "/", updateViaCache: "none" })
    .then((registration) => {
      const offer = (worker: ServiceWorker | null) => {
        // A waiting worker while another controls the page is a new version.
        if (worker && navigator.serviceWorker.controller) {
          updateWaiting = worker
          notify()
        }
      }
      offer(registration.waiting)
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed") offer(worker)
          // A worker that took over by itself (development builds, which
          // cache nothing) isn't waiting for a reload any more.
          if (
            (worker.state === "activated" || worker.state === "redundant") &&
            updateWaiting === worker
          ) {
            updateWaiting = null
            notify()
          }
        })
      })
      // A page left open for days still notices deploys.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible")
          registration.update().catch(() => {})
      })
    })
    .catch(() => {})
}

/** A new version is installed and waiting; reloadToUpdate switches to it. */
export function useUpdateAvailable(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => updateWaiting !== null,
    () => false
  )
}

export function reloadToUpdate() {
  const worker = updateWaiting
  if (!worker) {
    window.location.reload()
    return
  }
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => window.location.reload(),
    { once: true }
  )
  worker.postMessage({ type: "vidura:skip-waiting" })
}

// --- theme colour -------------------------------------------------------------

const THEME_COLORS = { light: "#fafafa", dark: "#0f0f0f" }

/**
 * Keeps the browser chrome and status bar the header's colour when the
 * theme is chosen in Settings rather than following the device: the
 * <meta name="theme-color"> tags in index.html only know the device's.
 */
export function syncThemeColor() {
  const apply = () => {
    const dark = document.documentElement.classList.contains("dark")
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => {
        meta.content = dark ? THEME_COLORS.dark : THEME_COLORS.light
      })
  }
  apply()
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  })
}

// --- notifications --------------------------------------------------------------

export type PushState =
  | "unsupported" // no service worker / Push API
  | "needs-install" // iPhone/iPad: only installed apps get push
  | "blocked" // the user denied permission
  | "off"
  | "on"

export function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  )
}

/** The service worker, or an error if it isn't running within a while. */
async function registration(): Promise<ServiceWorkerRegistration> {
  let timer = 0
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error("The service worker isn't running.")),
      10_000
    )
  })
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout])
  } finally {
    window.clearTimeout(timer)
  }
}

/** The Push API wants the VAPID key as bytes. */
function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/")
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** This device's push endpoint, when it's subscribed. */
export async function pushEndpoint(): Promise<string> {
  if (!pushSupported() || Notification.permission !== "granted") return ""
  try {
    const reg = await registration()
    return (await reg.pushManager.getSubscription())?.endpoint ?? ""
  } catch {
    return ""
  }
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported())
    return isIOS() && !isStandalone() ? "needs-install" : "unsupported"
  if (Notification.permission === "denied") return "blocked"
  const reg = await registration()
  const sub = await reg.pushManager.getSubscription()
  if (!sub || Notification.permission !== "granted") return "off"
  const { subscribed } = await api.post<{ subscribed: boolean }>(
    "/api/push/status",
    { endpoint: sub.endpoint }
  )
  if (!subscribed) {
    // The browser is subscribed but the server forgot it (another account
    // signed in here, or it was cleaned up): tell the server again.
    await api.post("/api/push/subscribe", sub.toJSON())
  }
  return "on"
}

export async function enablePush(): Promise<PushState> {
  // Asked first, straight from the tap: Safari only shows the permission
  // prompt from a user gesture.
  const permission = await Notification.requestPermission()
  if (permission !== "granted")
    return permission === "denied" ? "blocked" : "off"
  const { publicKey } = await api.get<{ publicKey: string }>("/api/push/key")
  const reg = await registration()
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    })
  }
  await api.post("/api/push/subscribe", sub.toJSON())
  return "on"
}

export async function disablePush(): Promise<PushState> {
  const reg = await registration()
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    await api.post("/api/push/unsubscribe", { endpoint: sub.endpoint })
    await sub.unsubscribe()
  }
  return "off"
}

/** The app icon's badge (installed apps on Android, iOS, desktop). */
export function setAppBadge(count: number) {
  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  if (!nav.setAppBadge || !nav.clearAppBadge) return
  const done = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()
  done.catch(() => {})
}

/** Closes this device's system notifications for the given IDs. */
export async function closeSystemNotifications(ids: string[]) {
  if (!ids.length || !("serviceWorker" in navigator)) return
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const shown = (await reg?.getNotifications()) ?? []
    for (const notification of shown) {
      if (ids.includes(notification.data?.id)) notification.close()
    }
  } catch {
    // Nothing to close.
  }
}
