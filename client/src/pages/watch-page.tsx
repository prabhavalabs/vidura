import * as React from "react"
import {
  AlertCircleIcon,
  GraduationCapIcon,
  MessageCircleQuestionIcon,
  PanelRightIcon,
  RectangleHorizontalIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  SearchXIcon,
} from "lucide-react"
import { cn } from "cn"
import { Link, useParams, useSearchParams } from "react-router"
import { toast } from "sonner"

import { VideoChat } from "@/components/chat/video-chat"
import { LearnPanel } from "@/components/learn/learn-panel"
import { Player, type PlayerHandle } from "@/components/player"
import { Transcript } from "@/components/transcript"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { VideoActions } from "@/components/video-actions"
import { VideoProgress } from "@/components/video-status"
import { ApiError, errorMessage } from "@/lib/api"
import { ago, clock } from "@/lib/format"
import { useLocale, useT } from "@/lib/i18n"
import { usePrefs } from "@/lib/prefs"
import { isProcessing, useRequestRun, useVideo } from "@/lib/queries"
import { lineAt } from "@/lib/segments"
import type { Segment, Video } from "@/lib/types"

/*
 * Layout. The page fills the window (AppLayout gives it the space between
 * the header and the bottom edge) and is a size container, so 100cqh is the
 * height it has to work with.
 *
 * - Phones and tablets: the player on top, edge to edge on phones, then the
 *   title, then the Transcript / Learn / Ask panel filling what's left and
 *   scrolling inside itself, so the video never scrolls away.
 * - Desktop, side by side: the player is as wide as the height allows
 *   ((100cqh - room for the title) * 16/9) and gives way when the window is
 *   narrow; the panel takes the rest, between 22rem and 36rem. A short
 *   window shrinks the video instead of pushing the transcript off screen.
 * - Desktop, wide player: the video as large as the window allows with the
 *   panel below it, and the page scrolls between them.
 */

const DESKTOP = "(min-width: 1024px)"
const WIDE_KEY = "vidura.watch.wide"

type PanelTab = "transcript" | "learn" | "ask"

export function WatchPage() {
  const t = useT()
  const { id = "" } = useParams()
  const detail = useVideo(id)

  if (detail.isPending) return <WatchSkeleton />
  if (detail.isError) {
    const missing =
      detail.error instanceof ApiError && detail.error.status === 404
    return (
      <ScrollArea className="min-h-0 flex-1">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>
              {missing ? t.watch.notInLibrary : t.watch.loadFailed}
            </EmptyTitle>
            <EmptyDescription>
              {missing ? t.watch.maybeDeleted : errorMessage(detail.error)}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/">{t.common.back}</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </ScrollArea>
    )
  }

  const { video, segments } = detail.data
  if (segments.length === 0) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 pb-4">
          <VideoMeta video={video} />
          <NotReady video={video} />
        </div>
      </ScrollArea>
    )
  }
  return <Watching key={video.id} video={video} segments={segments} />
}

function useMediaQuery(query: string) {
  return React.useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches,
    () => false
  )
}

/** The wide-player choice, remembered in this browser. */
function useWide(): [boolean, (wide: boolean) => void] {
  const [wide, setWide] = React.useState(() => {
    try {
      return localStorage.getItem(WIDE_KEY) === "1"
    } catch {
      return false
    }
  })
  const set = React.useCallback((next: boolean) => {
    setWide(next)
    try {
      localStorage.setItem(WIDE_KEY, next ? "1" : "0")
    } catch {
      // Private browsing: remember it for this visit only.
    }
  }, [])
  return [wide, set]
}

function Watching({ video, segments }: { video: Video; segments: Segment[] }) {
  const prefs = usePrefs()
  const [params] = useSearchParams()
  // Links can open a tab (?tab=ask from a notification) or a moment (?t=ms).
  const [startMs] = React.useState(() => Number(params.get("t")) || 0)
  const [initialTab] = React.useState<PanelTab>(() => {
    const tab = params.get("tab")
    return tab === "ask" || tab === "learn" ? tab : "transcript"
  })
  const player = React.useRef<PlayerHandle>(null)
  const scroller = React.useRef<HTMLDivElement>(null)
  const desktop = useMediaQuery(DESKTOP)
  const [wideChoice, setWide] = useWide()
  const wide = desktop && wideChoice

  const [active, setActive] = React.useState(() => lineAt(segments, startMs))
  // Only a change of line re-renders the transcript, not every tick.
  const onTime = React.useCallback(
    (ms: number) => setActive(lineAt(segments, ms)),
    [segments]
  )
  const seek = React.useCallback(
    (ms: number) => {
      player.current?.seek(ms)
      // With the panel below a wide player, bring the video back into view.
      if (wide) {
        scroller.current
          ?.querySelector("[data-slot=scroll-area-viewport]")
          ?.scrollTo({ top: 0, behavior: "smooth" })
      }
    },
    [wide]
  )

  // Room under the video for the title row, plus the subtitle strip when
  // subtitles sit below the picture instead of over it.
  const below = prefs.captions && prefs.placement === "below"
  const style = { "--meta": below ? "10.75rem" : "5.75rem" } as React.CSSProperties

  return (
    <div
      // Phones: edge to edge (main has 1rem padding on each side and top).
      className="relative -mx-4 -mt-4 flex min-h-0 flex-1 flex-col [container-type:size] sm:mx-0 sm:mt-0"
      style={style}
    >
      <ScrollArea
        ref={scroller}
        // Radix lays the content out as a table, which would let the wide
        // video push the page sideways; a block keeps it to the width.
        className="h-full [&>[data-slot=scroll-area-viewport]>div]:block!"
      >
        <div
          className={cn(
            "flex w-[100cqw] flex-col",
            wide
              ? "gap-5 pb-1"
              : "h-[100cqh] gap-3 lg:flex-row lg:justify-center lg:gap-5"
          )}
        >
          <div
            className={cn(
              "flex shrink-0 flex-col gap-3",
              wide
                ? "mx-auto w-full max-w-[calc((100cqh-var(--meta))*16/9)]"
                : "lg:min-w-0 lg:shrink lg:grow-0 lg:basis-[calc((100cqh-var(--meta))*16/9)]"
            )}
          >
            <div
              className={cn(
                // Tablets and landscape phones: never so tall that the
                // panel below has no room.
                "w-full sm:mx-auto sm:max-w-[max(18rem,calc((100cqh-var(--meta)-14rem)*16/9))]",
                "lg:max-w-none"
              )}
            >
              <Player
                ref={player}
                youtubeId={video.youtubeId}
                youtubeUrl={video.youtubeUrl}
                thumbnailUrl={video.thumbnailUrl}
                segments={segments}
                onTime={onTime}
                startMs={startMs}
                className="rounded-none sm:rounded-xl"
              />
            </div>
            <VideoMeta
              video={video}
              className="px-4 sm:px-0"
              layout={
                desktop ? (
                  <LayoutToggle wide={wideChoice} onChange={setWide} />
                ) : null
              }
            />
          </div>
          <SidePanel
            video={video}
            segments={segments}
            active={active}
            onSeek={seek}
            initialTab={initialTab}
            className={cn(
              "px-4 sm:px-0",
              wide
                ? "mx-auto h-[calc(100cqh-1.25rem)] w-full max-w-4xl"
                : "min-h-0 flex-1 pb-1 lg:max-w-[36rem] lg:min-w-[24rem] lg:basis-[26rem] lg:pb-0"
            )}
          />
        </div>
      </ScrollArea>
    </div>
  )
}

/** Title, channel, length and when it was added, with the video's menu. */
function VideoMeta({
  video,
  layout,
  className,
}: {
  video: Video
  layout?: React.ReactNode
  className?: string
}) {
  const { locale } = useLocale()
  return (
    <header className={cn("flex items-start gap-3", className)}>
      <div className="min-w-0 flex-1">
        <h1
          className="line-clamp-2 font-heading text-base leading-snug font-semibold text-balance sm:text-lg"
          title={video.title}
        >
          {video.title}
        </h1>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          {video.channelTitle ?? "YouTube"}
          {video.durationMs != null && ` · ${clock(video.durationMs)}`}
          {` · ${ago(video.createdAt, locale)}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {layout}
        <VideoActions video={video} />
      </div>
    </header>
  )
}

function LayoutToggle({
  wide,
  onChange,
}: {
  wide: boolean
  onChange: (wide: boolean) => void
}) {
  const t = useT()
  const label = wide ? t.watch.sideBySide : t.watch.wide
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          onClick={() => onChange(!wide)}
          aria-label={label}
          aria-pressed={wide}
        >
          {wide ? <PanelRightIcon /> : <RectangleHorizontalIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Beside (or below) the player: the transcript, study tools and the tutor. */
function SidePanel({
  video,
  segments,
  active,
  onSeek,
  initialTab,
  className,
}: {
  video: Video
  segments: Segment[]
  active: number
  onSeek: (ms: number) => void
  initialTab: PanelTab
  className?: string
}) {
  const t = useT()
  const [tab, setTab] = React.useState<PanelTab>(initialTab)
  // A tab mounts the first time it's opened and then stays mounted, so a
  // half-typed question or a quiz in progress survives switching tabs.
  const [opened, setOpened] = React.useState<Set<PanelTab>>(
    () => new Set([initialTab])
  )
  const open = (value: string) => {
    const next = value as PanelTab
    setTab(next)
    setOpened((seen) => (seen.has(next) ? seen : new Set(seen).add(next)))
  }
  const processing = isProcessing(video)
  const untranslated = segments.some((segment) => !segment.translation)

  return (
    <Tabs
      value={tab}
      onValueChange={open}
      className={cn("flex flex-col gap-3", className)}
    >
      {processing && (
        <Card className="py-3">
          <CardContent className="px-4">
            <VideoProgress video={video} />
          </CardContent>
        </Card>
      )}
      {!processing && video.status === "failed" && (
        <FailedAlert video={video} />
      )}
      {!processing && video.status === "ready" && untranslated && (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>{t.watch.untranslatedTitle}</AlertTitle>
          <AlertDescription>{t.watch.untranslatedBody}</AlertDescription>
        </Alert>
      )}
      <TabsList className="w-full shrink-0">
        <TabsTrigger value="transcript">
          <ScrollTextIcon />
          {t.tabs.transcript}
        </TabsTrigger>
        <TabsTrigger value="learn">
          <GraduationCapIcon />
          {t.tabs.learn}
        </TabsTrigger>
        <TabsTrigger value="ask">
          <MessageCircleQuestionIcon />
          {t.tabs.ask}
        </TabsTrigger>
      </TabsList>
      {opened.has("transcript") && (
        <TabsContent
          value="transcript"
          forceMount
          className="flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <Transcript segments={segments} active={active} onSeek={onSeek} />
        </TabsContent>
      )}
      {opened.has("learn") && (
        <TabsContent
          value="learn"
          forceMount
          className="flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <LearnPanel videoId={video.id} onSeek={onSeek} />
        </TabsContent>
      )}
      {opened.has("ask") && (
        <TabsContent
          value="ask"
          forceMount
          className="flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <VideoChat videoId={video.id} onSeek={onSeek} />
        </TabsContent>
      )}
    </Tabs>
  )
}

/** No transcript yet: show the run's progress, or why it failed. */
function NotReady({ video }: { video: Video }) {
  const t = useT()
  const processing = isProcessing(video)
  return (
    <Card className="w-full gap-0 overflow-hidden py-0">
      <div className="relative aspect-video bg-muted">
        {video.thumbnailUrl && (
          <img
            src={video.thumbnailUrl}
            alt=""
            className="size-full object-cover opacity-60"
          />
        )}
        {processing && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-background/90 p-3 shadow">
              <Spinner className="size-6" />
            </span>
          </div>
        )}
      </div>
      <CardContent className="flex flex-col gap-4 p-5">
        {processing ? (
          <>
            <VideoProgress video={video} />
            <p className="text-sm text-muted-foreground">
              {t.watch.processingBody}
            </p>
          </>
        ) : (
          <FailedAlert video={video} />
        )}
      </CardContent>
    </Card>
  )
}

function FailedAlert({ video }: { video: Video }) {
  const t = useT()
  const run = useRequestRun(video.id)
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>{t.watch.failedTitle}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{video.errorMessage ?? t.common.somethingWrong}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={run.isPending}
          onClick={() =>
            run.mutate("process_video", {
              onSuccess: () => toast(t.watch.retrying),
              onError: (error) => toast.error(errorMessage(error)),
            })
          }
        >
          {run.isPending ? <Spinner /> : <RotateCcwIcon />}
          {t.common.tryAgain}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

function WatchSkeleton() {
  return (
    <div className="-mx-4 -mt-4 flex min-h-0 flex-1 flex-col gap-3 sm:mx-0 sm:mt-0 lg:flex-row lg:gap-5">
      <div className="flex shrink-0 flex-col gap-3 lg:flex-1">
        <Skeleton className="aspect-video w-full rounded-none sm:rounded-xl" />
        <div className="flex flex-col gap-2 px-4 sm:px-0">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 sm:px-0 lg:max-w-[28rem]">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="min-h-0 w-full flex-1 rounded-xl" />
      </div>
    </div>
  )
}
