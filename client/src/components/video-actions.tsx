import * as React from "react"
import {
  CopyIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  LanguagesIcon,
  MessageCircleQuestionIcon,
  MicIcon,
  PlayIcon,
  Share2Icon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { errorMessage } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { isProcessing, useDeleteVideo, useRequestRun } from "@/lib/queries"
import type { JobKind, Video } from "@/lib/types"
import { cn } from "@/lib/utils"

type Action =
  | { kind: "separator"; key: string }
  | {
      kind: "item"
      key: string
      icon: LucideIcon
      label: string
      onSelect?: () => void
      href?: string
      disabled?: boolean
      destructive?: boolean
    }

/**
 * Everything a person can do with one video. The same list feeds the "⋮"
 * menu (watch page and library cards) and the right-click / long-press menu
 * on a card, so the two never drift apart.
 */
function useVideoActions(video: Video, { onCard }: { onCard: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const run = useRequestRun(video.id)
  const remove = useDeleteVideo()
  const [confirming, setConfirming] = React.useState(false)
  const busy = isProcessing(video)
  const watchUrl = `/watch/${video.id}`

  function request(kind: JobKind, done: string) {
    run.mutate(kind, {
      onSuccess: () => toast(done),
      onError: (error) => toast.error(errorMessage(error)),
    })
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(video.youtubeUrl)
      toast(t.actions.copied)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  async function share() {
    if (!navigator.share) return copyLink()
    try {
      await navigator.share({ title: video.title, url: video.youtubeUrl })
    } catch {
      // Sharing was cancelled.
    }
  }

  const actions: Action[] = [
    ...(onCard
      ? ([
          {
            kind: "item",
            key: "open",
            icon: PlayIcon,
            label: t.actions.open,
            onSelect: () => navigate(watchUrl),
          },
          {
            kind: "item",
            key: "tab",
            icon: SquareArrowOutUpRightIcon,
            label: t.actions.openNewTab,
            href: watchUrl,
          },
        ] satisfies Action[])
      : []),
    {
      kind: "item",
      key: "ask",
      icon: MessageCircleQuestionIcon,
      label: t.actions.askAbout,
      disabled: video.status !== "ready",
      onSelect: () => navigate(`${watchUrl}?tab=ask`),
    },
    { kind: "separator", key: "s1" },
    {
      kind: "item",
      key: "translate",
      icon: LanguagesIcon,
      label: t.actions.translateAgain,
      disabled: busy || video.segments === 0,
      onSelect: () => request("retranslate", t.actions.translating),
    },
    {
      kind: "item",
      key: "transcribe",
      icon: MicIcon,
      label: t.actions.transcribeAgain,
      disabled: busy,
      onSelect: () => request("retranscribe", t.actions.transcribing),
    },
    { kind: "separator", key: "s2" },
    {
      kind: "item",
      key: "share",
      icon: Share2Icon,
      label: t.actions.share,
      onSelect: share,
    },
    {
      kind: "item",
      key: "copy",
      icon: CopyIcon,
      label: t.actions.copyLink,
      onSelect: copyLink,
    },
    {
      kind: "item",
      key: "youtube",
      icon: ExternalLinkIcon,
      label: t.actions.openYouTube,
      href: video.youtubeUrl,
    },
    { kind: "separator", key: "s3" },
    {
      kind: "item",
      key: "delete",
      icon: Trash2Icon,
      label: t.actions.delete,
      destructive: true,
      onSelect: () => setConfirming(true),
    },
  ]

  const dialog = (
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.actions.deleteTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {t.actions.deleteBody(video.title)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.actions.keep}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              remove.mutate(video.id, {
                onSuccess: () => {
                  toast(t.actions.deleted)
                  // Leave the watch page of a deleted video; on the library
                  // the card simply disappears.
                  if (location.pathname.startsWith(watchUrl)) {
                    navigate("/", { replace: true })
                  }
                },
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            {t.actions.deleteConfirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { actions, dialog }
}

function external(href: string) {
  return href.startsWith("http")
    ? { target: "_blank", rel: "noreferrer" }
    : { target: "_blank" }
}

function DropdownItems({ actions }: { actions: Action[] }) {
  return actions.map((action) =>
    action.kind === "separator" ? (
      <DropdownMenuSeparator key={action.key} />
    ) : action.href ? (
      <DropdownMenuItem key={action.key} asChild disabled={action.disabled}>
        <a href={action.href} {...external(action.href)}>
          <action.icon />
          {action.label}
        </a>
      </DropdownMenuItem>
    ) : (
      <DropdownMenuItem
        key={action.key}
        disabled={action.disabled}
        variant={action.destructive ? "destructive" : "default"}
        onSelect={action.onSelect}
      >
        <action.icon />
        {action.label}
      </DropdownMenuItem>
    )
  )
}

function ContextItems({ actions }: { actions: Action[] }) {
  return actions.map((action) =>
    action.kind === "separator" ? (
      <ContextMenuSeparator key={action.key} />
    ) : action.href ? (
      <ContextMenuItem key={action.key} asChild disabled={action.disabled}>
        <a href={action.href} {...external(action.href)}>
          <action.icon />
          {action.label}
        </a>
      </ContextMenuItem>
    ) : (
      <ContextMenuItem
        key={action.key}
        disabled={action.disabled}
        variant={action.destructive ? "destructive" : "default"}
        onSelect={action.onSelect}
      >
        <action.icon />
        {action.label}
      </ContextMenuItem>
    )
  )
}

/** The "⋮" menu on the watch page. */
export function VideoActions({ video }: { video: Video }) {
  const t = useT()
  const { actions, dialog } = useVideoActions(video, { onCard: false })
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label={t.actions.more}>
            <EllipsisVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownItems actions={actions} />
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  )
}

/**
 * Wraps a library card: right-click (desktop) or long-press (touch) opens the
 * actions, and a "⋮" button in the corner opens the same list, since a hidden
 * gesture alone isn't discoverable. With a mouse the button shows on hover;
 * on touch screens it is always there.
 */
export function VideoCardActions({
  video,
  children,
}: {
  video: Video
  children: React.ReactNode
}) {
  const t = useT()
  const { actions, dialog } = useVideoActions(video, { onCard: true })
  return (
    <div className="group/card relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ContextItems actions={actions} />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={t.actions.more}
            className={cn(
              "absolute top-2 right-2 bg-black/60 text-white shadow-sm backdrop-blur hover:bg-black/80",
              "transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/card:opacity-100",
              "focus-visible:opacity-100 data-[state=open]:opacity-100"
            )}
          >
            <EllipsisVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownItems actions={actions} />
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </div>
  )
}
