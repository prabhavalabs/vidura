import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"

import { api, apiUrl } from "@/lib/api"
import { closeSystemNotifications, pushEndpoint, setAppBadge } from "@/lib/pwa"

// The notification list behind the bell and the app icon's badge. The
// server keeps every notification it sends (push.Service.Send), read or not.

export type AppNotification = {
  id: string
  kind: string
  title: string
  body: string
  url: string
  createdAt: string
  readAt: string | null
}

export type NotificationList = {
  notifications: AppNotification[]
  unread: number
}

export const notificationKeys = { all: ["notifications"] as const }

export function useNotifications() {
  return useQuery({
    queryKey: notificationKeys.all,
    queryFn: () => api.get<NotificationList>("/api/notifications"),
    staleTime: 10_000,
  })
}

function applyRead(
  client: QueryClient,
  ids: string[] | "all",
  unread?: number
) {
  client.setQueryData<NotificationList>(notificationKeys.all, (list) => {
    if (!list) return list
    const now = new Date().toISOString()
    const notifications = list.notifications.map((n) =>
      !n.readAt && (ids === "all" || ids.includes(n.id))
        ? { ...n, readAt: now }
        : n
    )
    return {
      notifications,
      unread:
        unread ?? notifications.filter((notification) => !notification.readAt).length,
    }
  })
}

export function useMarkRead() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[] | "all") =>
      api.post<{ unread: number }>(
        "/api/notifications/read",
        ids === "all" ? { all: true } : { ids }
      ),
    // The bell and badge update at once; the server's count follows.
    onMutate: (ids) => applyRead(client, ids),
    onSuccess: ({ unread }, ids) => {
      applyRead(client, ids, unread)
      if (ids !== "all") closeSystemNotifications(ids)
    },
  })
}

/** The path part of a notification's URL ("/watch/x?tab=ask" → "/watch/x"). */
export function notificationPath(url: string): string {
  return new URL(url, window.location.origin).pathname
}

// The open app tells the server it's on screen this often, so pushes to
// this device are held back while it is (the server forgets after 50s).
const HEARTBEAT_MS = 20_000

const TOAST_WITHIN_MS = 90_000

type Presence = { unread: number; latest: string }

async function sayPresence(visible: boolean): Promise<Presence | null> {
  const endpoint = await pushEndpoint()
  try {
    if (!visible) {
      // keepalive lets this go out while the page is being hidden or closed.
      await fetch(apiUrl + "/api/notifications/presence", {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible, endpoint }),
      })
      return null
    }
    return await api.post<Presence>("/api/notifications/presence", {
      visible,
      endpoint,
    })
  } catch {
    return null
  }
}

type SyncOptions = {
  /** Called for each notification that arrives while the app is on screen. */
  onArrive: (notification: AppNotification) => void
  /** Called when a tapped system notification asks the app to open a page. */
  onOpen: (url: string) => void
  /** The page being shown: its unread notifications count as read. */
  pathname: string
}

/**
 * Keeps the bell, the app icon badge and the server in step with this open
 * app. Mount it once (the bell does).
 */
export function useNotificationSync({ onArrive, onOpen, pathname }: SyncOptions) {
  const client = useQueryClient()
  const list = useNotifications()
  const markRead = useMarkRead()
  const seen = React.useRef<Set<string> | null>(null)
  const latest = React.useRef({ onArrive, onOpen })
  React.useEffect(() => {
    latest.current = { onArrive, onOpen }
  })

  // Heartbeat while visible; "hidden" once when not. A newer notification
  // than the list shows means a refetch (and a toast, below).
  React.useEffect(() => {
    let timer = 0
    const beat = async () => {
      const presence = await sayPresence(true)
      const current = client.getQueryData<NotificationList>(notificationKeys.all)
      if (
        presence &&
        current &&
        (presence.latest !== (current.notifications[0]?.id ?? "") ||
          presence.unread !== current.unread)
      ) {
        client.invalidateQueries({ queryKey: notificationKeys.all })
      }
    }
    const onVisibility = () => {
      window.clearInterval(timer)
      if (document.visibilityState === "visible") {
        beat()
        timer = window.setInterval(beat, HEARTBEAT_MS)
      } else {
        sayPresence(false)
      }
    }
    const onPageHide = () => sayPresence(false)
    onVisibility()
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", onPageHide)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", onPageHide)
    }
  }, [client])

  // Messages from the service worker: a push arrived, or a notification
  // was tapped while this window was open.
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string; id?: string }
      if (data?.type === "vidura:notification") {
        client.invalidateQueries({ queryKey: notificationKeys.all })
      } else if (data?.type === "vidura:open" && typeof data.url === "string") {
        if (data.url.startsWith("/") && !data.url.startsWith("//"))
          latest.current.onOpen(data.url)
      }
    }
    navigator.serviceWorker.addEventListener("message", onMessage)
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage)
  }, [client])

  // New notifications while on screen become toasts. The first load only
  // fills the "seen" set: old news isn't announced.
  const notifications = list.data?.notifications
  React.useEffect(() => {
    if (!notifications) return
    if (seen.current === null) {
      seen.current = new Set(notifications.map((n) => n.id))
      return
    }
    for (const n of notifications) {
      if (seen.current.has(n.id)) continue
      seen.current.add(n.id)
      // Only news from the last minute or so: something that arrived while
      // the app was in the background already had its system notification.
      const fresh = Date.now() - new Date(n.createdAt).getTime() < TOAST_WITHIN_MS
      if (
        fresh &&
        !n.readAt &&
        document.visibilityState === "visible" &&
        notificationPath(n.url) !== window.location.pathname
      ) {
        latest.current.onArrive(n)
      }
    }
  }, [notifications])

  // Opening the page a notification is about reads it.
  const { mutate } = markRead
  React.useEffect(() => {
    if (!notifications) return
    const ids = notifications
      .filter((n) => !n.readAt && notificationPath(n.url) === pathname)
      .map((n) => n.id)
    if (ids.length) mutate(ids)
  }, [notifications, pathname, mutate])

  // The app icon shows the unread count.
  const unread = list.data?.unread
  React.useEffect(() => {
    if (unread !== undefined) setAppBadge(unread)
  }, [unread])

  return list
}
