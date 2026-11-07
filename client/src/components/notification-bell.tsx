import * as React from "react"
import {
  BellIcon,
  BookOpenIcon,
  CheckCheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  DownloadIcon,
  ImageIcon,
  MessageCircleIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "cn"
import { Link, useLocation, useNavigate } from "react-router"
import { toast } from "sonner"

import { useInstallApp } from "@/components/install-app"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { useLocale } from "@/lib/i18n"
import {
  useMarkRead,
  useNotificationSync,
  type AppNotification,
} from "@/lib/notifications"
import { reloadToUpdate, useUpdateAvailable } from "@/lib/pwa"

const kindIcons: Record<string, LucideIcon> = {
  video_ready: CircleCheckIcon,
  video_failed: CircleAlertIcon,
  chat_answer: MessageCircleIcon,
  chat_failed: CircleAlertIcon,
  notes_ready: BookOpenIcon,
  notes_failed: CircleAlertIcon,
  picture_ready: ImageIcon,
  picture_failed: CircleAlertIcon,
}

function KindIcon({ kind, className }: { kind: string; className: string }) {
  return React.createElement(kindIcons[kind] ?? BellIcon, { className })
}

/**
 * The header's bell: unread count, recent notifications, and the app-wide
 * notification plumbing (toasts for news while the app is open, the app
 * icon badge, taps on system notifications, the "new version" prompt).
 */
export function NotificationBell() {
  const { t, locale } = useLocale()
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = React.useState(false)
  const markRead = useMarkRead()
  const install = useInstallApp()

  const list = useNotificationSync({
    pathname: location.pathname,
    onOpen: (url) => navigate(url),
    onArrive: (n) =>
      toast(n.title, {
        description: n.body,
        action: { label: t.notify.open, onClick: () => navigate(n.url) },
      }),
  })
  useUpdateToast()

  const notifications = list.data?.notifications ?? []
  const unread = list.data?.unread ?? 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            unread > 0
              ? `${t.notify.bell}, ${t.notify.unread(unread)}`
              : t.notify.bell
          }
        >
          <BellIcon />
          {unread > 0 && (
            <Badge className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 text-[10px] tabular-nums">
              {unread > 99 ? "99+" : unread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={16}
        // Focus the panel, not "Mark all as read": a ring on a button the
        // person didn't reach for reads as a selection.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus()
        }}
        tabIndex={-1}
        className="w-[min(24rem,calc(100vw-2rem))] gap-0 p-0"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{t.notify.bell}</span>
            {unread > 0 && (
              <span className="text-xs text-muted-foreground">
                {t.notify.unread(unread)}
              </span>
            )}
          </div>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => markRead.mutate("all")}
            >
              <CheckCheckIcon />
              {t.notify.markAllRead}
            </Button>
          )}
        </div>
        <Separator />
        {notifications.length === 0 ? (
          <Empty className="border-0 py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellIcon />
              </EmptyMedia>
              <EmptyTitle>{t.notify.emptyTitle}</EmptyTitle>
              <EmptyDescription>{t.notify.emptyBody}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="max-h-[min(26rem,60svh)]">
            <ul className="flex flex-col p-1">
              {notifications.map((n) => (
                <NotificationRow
                  key={n.id}
                  notification={n}
                  locale={locale}
                  onOpen={() => {
                    if (!n.readAt) markRead.mutate([n.id])
                    setOpen(false)
                  }}
                />
              ))}
            </ul>
          </ScrollArea>
        )}
        {install.available && (
          <>
            <Separator />
            <div className="p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setOpen(false)
                  install.start()
                }}
              >
                <DownloadIcon />
                {t.install.menuItem}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
      {install.dialog}
    </Popover>
  )
}

function NotificationRow({
  notification: n,
  locale,
  onOpen,
}: {
  notification: AppNotification
  locale: string
  onOpen: () => void
}) {
  const failed = n.kind.endsWith("_failed")
  return (
    <li>
      <Link
        to={n.url}
        onClick={onOpen}
        className="flex gap-3 rounded-md px-2.5 py-2 transition-colors outline-none hover:bg-muted focus-visible:bg-muted"
      >
        <KindIcon
          kind={n.kind}
          className={cn(
            "mt-0.5 size-4 shrink-0",
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "line-clamp-2 text-sm break-words",
              !n.readAt && "font-medium"
            )}
          >
            {n.title}
          </span>
          {n.body && (
            <span className="line-clamp-2 text-xs break-words text-muted-foreground">
              {n.body}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {timeAgo(n.createdAt, locale)}
          </span>
        </span>
        {!n.readAt && (
          <span
            className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
            aria-hidden
          />
        )}
      </Link>
    </li>
  )
}

function timeAgo(iso: string, locale: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
  ]
  let value = seconds
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit)
    value /= size
  }
  return format.format(Math.round(value), "year")
}

/** "A new version is ready" with a Reload button, once per waiting update. */
function useUpdateToast() {
  const t = useLocale().t
  const available = useUpdateAvailable()
  React.useEffect(() => {
    if (!available) return
    const id = toast(t.notify.updateReady, {
      duration: Infinity,
      action: { label: t.notify.reload, onClick: reloadToUpdate },
    })
    return () => {
      toast.dismiss(id)
    }
  }, [available, t])
}
