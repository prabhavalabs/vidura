// The details window for one video, opened from the Videos table (and from
// runs). Its state lives in the URL: ?video=<id>&tab=transcript.
import * as React from "react"
import {
  AlertCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  CopyIcon,
  ExternalLinkIcon,
  LanguagesIcon,
  LoaderIcon,
  MicIcon,
  MoreHorizontalIcon,
  RotateCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "cn"

import {
  JobStatusBadge,
  SourceBadge,
  VideoStatusBadge,
} from "@/components/badges"
import { RunProgress } from "@/components/cells"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useTableUrl } from "@/components/data-table"
import { errorMessage } from "@/lib/api"
import {
  formatClock,
  formatDateTime,
  formatMs,
  formatNumber,
  formatPercent,
} from "@/lib/format"
import {
  useCancelRun,
  useDeleteVideo,
  useRequestRun,
  useSystem,
  useVideo,
  type RunKind,
} from "@/lib/queries"
import type { Job, Segment, VideoDetail } from "@/lib/types"

const tabs = ["transcript", "runs", "context", "quality"] as const
type Tab = (typeof tabs)[number]

/** Opens when the URL has ?video=<id>. Mount once per page. */
export function VideoDialog() {
  const url = useTableUrl()
  const id = url.get("video")
  const tab = (tabs as readonly string[]).includes(url.get("tab") ?? "")
    ? (url.get("tab") as Tab)
    : "transcript"
  return (
    <Dialog
      open={Boolean(id)}
      onOpenChange={(open) => !open && url.update({ video: null, tab: null })}
    >
      <DialogContent className="flex h-[min(92vh,900px)] w-[calc(100vw-1.5rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        {id && (
          <VideoDetailView
            id={id}
            tab={tab}
            onTab={(next) =>
              url.update({ tab: next === "transcript" ? null : next })
            }
            onClose={() => url.update({ video: null, tab: null })}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Opens the video dialog for an id, keeping the rest of the URL. */
export function useOpenVideo() {
  const url = useTableUrl()
  return React.useCallback(
    (id: string) => url.update({ video: id, tab: null, run: null }, true),
    [url]
  )
}

function VideoDetailView({
  id,
  tab,
  onTab,
  onClose,
}: {
  id: string
  tab: Tab
  onTab: (tab: Tab) => void
  onClose: () => void
}) {
  const detail = useVideo(id)

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-4 p-5">
        <DialogTitle className="sr-only">Loading video</DialogTitle>
        <DialogDescription className="sr-only">Loading</DialogDescription>
        <Skeleton className="h-8 w-2/3" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="aspect-video" />
          <Skeleton className="h-full min-h-48" />
        </div>
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <DialogTitle>Couldn’t open this video</DialogTitle>
        <DialogDescription>{errorMessage(detail.error)}</DialogDescription>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }
  return (
    <Loaded detail={detail.data} tab={tab} onTab={onTab} onClose={onClose} />
  )
}

function Loaded({
  detail,
  tab,
  onTab,
  onClose,
}: {
  detail: VideoDetail
  tab: Tab
  onTab: (tab: Tab) => void
  onClose: () => void
}) {
  const { video, segments, jobs } = detail
  const system = useSystem()
  const share = video.segments > 0 ? video.translated / video.segments : 0
  const lastRun = jobs[0]
  const openRun = jobs.find(
    (job) => job.status === "queued" || job.status === "running"
  )
  const clientUrl = system.data?.urls.client

  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5 pr-12">
        <div className="flex min-w-0 flex-col gap-1.5">
          <DialogTitle className="line-clamp-1 text-base font-medium">
            {video.title}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
            <span>{video.youtubeId}</span>
            {video.channelTitle && <span>· {video.channelTitle}</span>}
          </DialogDescription>
          <div className="flex flex-wrap items-center gap-1.5">
            <VideoStatusBadge status={video.status} />
            <SourceBadge
              source={video.transcriptSource}
              engine={video.transcriptEngine}
            />
            {video.translationModel && (
              <Badge variant="outline" className="font-mono">
                {video.translationModel}
              </Badge>
            )}
            {openRun && <JobStatusBadge status={openRun.status} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {clientUrl && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={`${clientUrl}/watch/${video.id}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLinkIcon />
                <span className="hidden md:inline">Open in Vidura</span>
              </a>
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <a
              href={video.youtubeUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              <ExternalLinkIcon />
              <span className="hidden md:inline">YouTube</span>
            </a>
          </Button>
          <VideoActions
            videoId={video.id}
            title={video.title}
            youtubeUrl={video.youtubeUrl}
            openRunId={openRun?.id}
            onDeleted={onClose}
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="aspect-video overflow-hidden rounded-lg border bg-black">
              <iframe
                className="size-full"
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.youtubeId)}?rel=0`}
                title={video.title}
                allow="encrypted-media; picture-in-picture; fullscreen"
                referrerPolicy="strict-origin-when-cross-origin"
                loading="lazy"
              />
            </div>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 overflow-hidden rounded-lg border">
                <MiniStat
                  label="Length"
                  value={formatClock(video.durationMs)}
                  hint={`${formatNumber(video.segments)} English lines`}
                />
                <MiniStat
                  label="Translated"
                  value={formatPercent(share)}
                  hint={`${formatNumber(video.translated)} of ${formatNumber(video.segments)}`}
                  tone={share >= 1 ? "success" : "failure"}
                />
                <MiniStat
                  label="Last run"
                  value={formatMs(lastRun?.durationMs)}
                  hint={
                    lastRun
                      ? `${jobs.length} run${jobs.length === 1 ? "" : "s"}`
                      : "never run"
                  }
                />
                <MiniStat
                  label="Caption quality"
                  value={
                    video.qualityScore !== null
                      ? String(Math.round(video.qualityScore))
                      : "—"
                  }
                  hint={video.qualityLabel ?? "not scored"}
                />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5 text-[13px]">
                <Fact
                  label="Added by"
                  value={video.owner.name || video.owner.email}
                />
                <Fact label="Added" value={formatDateTime(video.createdAt)} />
                <Fact
                  label="Languages"
                  value={`${video.sourceLanguage ?? "?"} → ${video.targetLanguage}`}
                  mono
                />
                <Fact label="Video id" value={video.id.slice(0, 8)} mono />
              </dl>
              {openRun && (
                <Alert>
                  <RotateCwIcon />
                  <AlertTitle>A run is waiting</AlertTitle>
                  <AlertDescription>
                    Queued {formatDateTime(openRun.createdAt)}. The processing
                    worker picks it up once it’s running.
                  </AlertDescription>
                </Alert>
              )}
              {video.status === "failed" && video.errorMessage && !openRun && (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Last run failed</AlertTitle>
                  <AlertDescription>
                    <p className="line-clamp-3 font-mono text-xs break-all">
                      {video.errorMessage}
                    </p>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </div>

          <Tabs
            value={tab}
            onValueChange={(value) => onTab(value as Tab)}
            className="gap-3"
          >
            <TabsList>
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
              <TabsTrigger value="runs">
                Runs{" "}
                <span className="tabular text-muted-foreground">
                  {jobs.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="context" disabled={!video.translationContext}>
                Context
              </TabsTrigger>
              <TabsTrigger
                value="quality"
                disabled={!video.subtitleQuality?.metrics}
              >
                Quality
              </TabsTrigger>
            </TabsList>
            <TabsContent value="transcript">
              <TranscriptView segments={segments} />
            </TabsContent>
            <TabsContent value="runs">
              <RunsTimeline jobs={jobs} />
            </TabsContent>
            <TabsContent value="context">
              <ContextView detail={detail} />
            </TabsContent>
            <TabsContent value="quality">
              <QualityView detail={detail} />
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </>
  )
}

function MiniStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint: string
  tone?: "success" | "failure"
}) {
  return (
    <div className="flex flex-col gap-0.5 border-r border-b px-3 py-2.5 nth-[2n]:border-r-0 nth-[n+3]:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "tabular text-xl tracking-tight",
          tone === "failure" && "text-failure"
        )}
      >
        {value}
      </span>
      <span className="truncate text-xs text-muted-foreground">{hint}</span>
    </div>
  )
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono text-xs leading-5")}>
        {value}
      </dd>
    </div>
  )
}

// --- actions --------------------------------------------------------------

/** Re-run, retranslate, copy link and delete, for a menu or a row. */
export function VideoActions({
  videoId,
  title,
  youtubeUrl,
  openRunId,
  onDeleted,
  onView,
  trigger,
}: {
  videoId: string
  title: string
  youtubeUrl: string
  /** A queued or running job, which the menu offers to cancel. */
  openRunId?: string
  onDeleted?: () => void
  onView?: () => void
  trigger?: React.ReactNode
}) {
  const request = useRequestRun()
  const cancel = useCancelRun()
  const remove = useDeleteVideo()
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  const run = (kind: RunKind, label: string) =>
    request.mutate(
      { video: videoId, kind },
      {
        onSuccess: () => toast.success(`${label} queued`),
        onError: (error) => toast.error(errorMessage(error)),
      }
    )

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button variant="outline" size="icon-sm" aria-label="More actions">
              <MoreHorizontalIcon />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {onView && (
            <>
              <DropdownMenuItem onSelect={onView}>
                <SearchIcon />
                View details
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={youtubeUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLinkIcon />
                  Open on YouTube
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {openRunId ? (
            <DropdownMenuItem
              onSelect={() =>
                cancel.mutate(openRunId, {
                  onSuccess: () => toast.success("Run cancelled"),
                  onError: (error) => toast.error(errorMessage(error)),
                })
              }
            >
              <XIcon />
              Cancel this run
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem
                onSelect={() => run("process_video", "Full run")}
              >
                <RotateCwIcon />
                Re-run everything
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => run("retranslate", "Retranslation")}
              >
                <LanguagesIcon />
                Retranslate only
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => run("retranscribe", "Mac transcription")}
              >
                <MicIcon />
                Transcribe on the Mac
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem
            onSelect={() =>
              navigator.clipboard
                .writeText(`${window.location.origin}/videos?video=${videoId}`)
                .then(() => toast.success("Link copied"))
                .catch(() => toast.error("Couldn’t copy"))
            }
          >
            <CopyIcon />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirmDelete(true)}
          >
            <Trash2Icon />
            Delete video
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this video?</AlertDialogTitle>
            <AlertDialogDescription>
              “{title}” is removed with its transcript, translation, runs and
              chats. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                remove.mutate(videoId, {
                  onSuccess: () => {
                    toast.success("Video deleted")
                    onDeleted?.()
                  },
                  onError: (error) => toast.error(errorMessage(error)),
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// --- transcript -----------------------------------------------------------

function TranscriptView({ segments }: { segments: Segment[] }) {
  const [query, setQuery] = React.useState("")
  const [view, setView] = React.useState<"all" | "missing">("all")
  const deferred = React.useDeferredValue(query.trim().toLowerCase())
  const missing = segments.filter((s) => !s.translation?.trim()).length
  const shown = segments.filter((segment) => {
    if (view === "missing" && segment.translation?.trim()) return false
    if (!deferred) return true
    return (
      segment.text.toLowerCase().includes(deferred) ||
      (segment.translation ?? "").toLowerCase().includes(deferred)
    )
  })

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <InputGroup className="h-8 sm:max-w-xs">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search English or Sinhala"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search the transcript"
          />
        </InputGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view}
          onValueChange={(value) =>
            value && setView(value as "all" | "missing")
          }
        >
          <ToggleGroupItem value="all" className="px-3">
            All lines{" "}
            <span className="tabular text-muted-foreground">
              {segments.length}
            </span>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="missing"
            className="px-3"
            disabled={missing === 0}
          >
            Not translated
            {missing > 0 && (
              <span className="tabular text-failure">{missing}</span>
            )}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="hidden grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] gap-4 border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground lg:grid">
        <span>Time</span>
        <span>English</span>
        <span>Sinhala</span>
      </div>
      <ScrollArea className="h-[420px]">
        {shown.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            {deferred
              ? `Nothing matches “${query}”.`
              : "Every line is translated."}
          </p>
        ) : (
          <ol className="divide-y">
            {shown.map((segment) => (
              <li
                key={segment.index}
                className="grid gap-x-4 gap-y-1 px-3 py-2 lg:grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)]"
              >
                <span className="tabular font-mono text-xs text-muted-foreground lg:pt-0.5">
                  {formatClock(segment.startMs)}
                </span>
                <p className="text-[13px] leading-relaxed">{segment.text}</p>
                {segment.translation?.trim() ? (
                  <p className="text-[13px] leading-relaxed text-foreground/90">
                    {segment.translation}
                    {segment.edited && (
                      <Badge variant="outline" className="ml-2 align-middle">
                        Edited
                      </Badge>
                    )}
                  </p>
                ) : (
                  <p className="w-fit rounded-md border border-dashed border-failure/50 px-2 py-0.5 text-xs text-failure">
                    Not translated
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>
    </div>
  )
}

// --- runs -----------------------------------------------------------------

const detailLabels: Record<string, string> = {
  translator: "Translator",
  total_segments: "Lines",
  translated_segments: "Translated",
  remaining_segments: "Remaining",
  transcript_source: "Transcript",
  requested_language_code: "Language",
  stage: "Stage",
}

export function RunsTimeline({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) {
    return (
      <p className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">
        This video hasn’t been processed yet.
      </p>
    )
  }
  return (
    <ol className="flex flex-col rounded-lg border px-4 py-3">
      {jobs.map((job, index) => {
        const failed = job.status === "failed"
        const waiting = job.status === "queued" || job.status === "running"
        const facts = Object.entries(job.details).filter(
          ([key, value]) =>
            detailLabels[key] &&
            value !== null &&
            value !== "" &&
            typeof value !== "object"
        )
        return (
          <li key={job.id} className="relative flex gap-3 pb-4 last:pb-0">
            {index < jobs.length - 1 && (
              <span className="absolute top-7 bottom-1 left-[11px] border-l border-dashed" />
            )}
            <span
              className={cn(
                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
                failed && "border border-failure text-failure",
                waiting && "border border-dashed border-info text-info",
                job.status === "cancelled" && "border text-muted-foreground",
                job.status === "succeeded" && "bg-success text-background"
              )}
            >
              {failed || job.status === "cancelled" ? (
                <XIcon className="size-3.5" />
              ) : job.status === "running" ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : waiting ? (
                <CircleDashedIcon className="size-3" />
              ) : (
                <CheckIcon className="size-3.5" />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    "font-mono text-[13px]",
                    failed && "text-failure"
                  )}
                >
                  {job.kind === "process_video"
                    ? "Full run"
                    : job.kind === "retranslate"
                      ? "Retranslate"
                      : "Mac transcription"}{" "}
                  · {job.status}
                </span>
                <span className="tabular shrink-0 font-mono text-[13px]">
                  {formatMs(job.durationMs)}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(job.startedAt ?? job.createdAt)}
                {job.requestedBy && ` · ${job.requestedBy}`}
                {job.legacy && " · v1"}
              </span>
              {waiting && (
                <div className="flex items-center gap-3">
                  <RunProgress job={job} />
                  {job.status === "running" && job.details.stage ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {String(job.details.stage)}
                    </span>
                  ) : null}
                </div>
              )}
              {failed && job.errorMessage && (
                <p className="line-clamp-3 font-mono text-xs break-all text-failure/90">
                  {job.errorMessage}
                </p>
              )}
              {facts.length > 0 && (
                <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border bg-muted/30 p-2 text-xs sm:grid-cols-4">
                  {facts.map(([key, value]) => (
                    <div key={key} className="flex min-w-0 flex-col">
                      <dt className="text-muted-foreground">
                        {detailLabels[key]}
                      </dt>
                      <dd className="truncate font-mono">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// --- context and quality --------------------------------------------------

function ContextView({ detail }: { detail: VideoDetail }) {
  const context = detail.video.translationContext
  if (!context) return null
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-3 rounded-lg border p-3 text-[13px]">
        {context.topic && (
          <ContextBlock label="Topic">{context.topic}</ContextBlock>
        )}
        {context.summary && (
          <ContextBlock label="Summary">{context.summary}</ContextBlock>
        )}
        {context.audience && (
          <ContextBlock label="Audience">{context.audience}</ContextBlock>
        )}
        {context.translationGuidelines && (
          <ContextBlock label="Guidelines">
            {context.translationGuidelines}
          </ContextBlock>
        )}
      </div>
      {context.keyTerms && context.keyTerms.length > 0 && (
        <div className="flex flex-col overflow-hidden rounded-lg border">
          <span className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            Key terms · {context.keyTerms.length}
          </span>
          <ScrollArea className="max-h-[420px]">
            <ul className="divide-y">
              {context.keyTerms.map((term) => (
                <li
                  key={term.source}
                  className="grid grid-cols-2 gap-3 px-3 py-1.5 text-[13px]"
                >
                  <span className="font-mono text-xs leading-5">
                    {term.source}
                  </span>
                  <span>{term.preferredSinhala}</span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}

function ContextBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <p className="leading-relaxed">{children}</p>
    </div>
  )
}

const metricFormat: Record<string, (value: number) => string> = {
  segmentCount: (v) => formatNumber(v),
  coverageRatio: (v) => formatPercent(v, 0),
  largestGapMs: (v) => formatMs(v),
  overlapCount: (v) => formatNumber(v),
  outOfOrderCount: (v) => formatNumber(v),
  invalidDurationCount: (v) => formatNumber(v),
}

const metricNames: Record<string, string> = {
  segmentCount: "Caption cues",
  coverageRatio: "Speech covered",
  largestGapMs: "Longest gap",
  overlapCount: "Overlapping cues",
  outOfOrderCount: "Out of order",
  invalidDurationCount: "Bad timings",
}

function QualityView({ detail }: { detail: VideoDetail }) {
  const quality = detail.video.subtitleQuality
  if (!quality?.metrics) return null
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <span className="text-[13px]">
        Score{" "}
        <span className="tabular font-mono">
          {quality.score !== undefined ? Math.round(quality.score) : "—"}
        </span>
        <span className="text-muted-foreground"> / 100 · {quality.label}</span>
      </span>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] sm:grid-cols-3">
        {Object.entries(quality.metrics).map(([key, value]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">
              {metricNames[key] ?? key}
            </dt>
            <dd className="tabular font-mono">
              {value === null || value === undefined
                ? "—"
                : (metricFormat[key]?.(value) ?? String(value))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
