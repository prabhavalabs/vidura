import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import {
  ActivityIcon,
  CaptionsIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  CopyIcon,
  FilmIcon,
  HelpCircleIcon,
  LanguagesIcon,
  MicIcon,
  MoreHorizontalIcon,
  RotateCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "cn"

import { JobStatusBadge } from "@/components/badges"
import {
  isOpenJob,
  RunProgress,
  StackedMeter,
  VideoCell,
  WhenCell,
} from "@/components/cells"
import {
  DataTable,
  facetFilter,
  SortableHeader,
  useTableUrl,
  type Facet,
} from "@/components/data-table"
import { Page } from "@/components/site-header"
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useOpenVideo, VideoDialog } from "@/components/video-dialog"
import { DotColumns, LegendDot, Panel, type DotColumn } from "@/components/viz"
import { errorMessage } from "@/lib/api"
import {
  eachDay,
  formatDateTime,
  formatMs,
  formatNumber,
  formatShortDate,
  formatTime,
} from "@/lib/format"
import { useCancelRun, useJobs, useRequestRun, useStats } from "@/lib/queries"
import type { Job, Stats } from "@/lib/types"

const kindLabels: Record<Job["kind"], string> = {
  process_video: "Full run",
  retranslate: "Retranslate",
  retranscribe: "Mac transcription",
}

const statusOptions = [
  { value: "succeeded", label: "Succeeded", icon: CircleCheckIcon },
  { value: "failed", label: "Failed", icon: CircleXIcon },
  { value: "queued", label: "Queued", icon: CircleDashedIcon },
  { value: "running", label: "Running", icon: CircleDashedIcon },
  { value: "cancelled", label: "Cancelled", icon: XIcon },
]

const sourceOptions = [
  { value: "captions", label: "YouTube captions", icon: CaptionsIcon },
  { value: "asr", label: "Speech to text", icon: MicIcon },
  { value: "unknown", label: "Unknown", icon: HelpCircleIcon },
]

export function ProcessingPage() {
  const jobs = useJobs("")
  const stats = useStats()
  const url = useTableUrl()
  const openVideo = useOpenVideo()
  const data = React.useMemo(() => jobs.data ?? [], [jobs.data])
  const longest = Math.max(1, ...data.map((job) => job.durationMs ?? 0))
  const { update } = url
  const openRun = React.useCallback(
    (id: string) => update({ run: id, video: null }, true),
    [update]
  )
  const columns = React.useMemo(
    () => buildColumns(longest, openRun, openVideo),
    [longest, openRun, openVideo]
  )

  const facets: Facet[] = React.useMemo(
    () => [
      {
        column: "status",
        title: "Status",
        options: statusOptions.filter((o) =>
          data.some((j) => j.status === o.value)
        ),
      },
      {
        column: "kind",
        title: "Kind",
        options: (Object.keys(kindLabels) as Job["kind"][])
          .filter((kind) => data.some((j) => j.kind === kind))
          .map((kind) => ({ value: kind, label: kindLabels[kind] })),
      },
      {
        column: "source",
        title: "Transcript",
        options: sourceOptions.filter((o) =>
          data.some((j) => (j.video?.transcriptSource ?? "unknown") === o.value)
        ),
      },
    ],
    [data]
  )

  return (
    <Page crumbs={[{ label: "Processing" }]} title="Processing">
      {stats.data ? (
        <DailyRuns timeline={stats.data.timeline} />
      ) : (
        <Skeleton className="h-40 rounded-xl" />
      )}

      <DataTable
        columns={columns}
        data={data}
        loading={jobs.isPending}
        facets={facets}
        getRowId={(job) => job.id}
        activeRowId={url.get("run")}
        searchPlaceholder="Search runs by video or id"
        initialSort={{ id: "started", desc: true }}
        onRowClick={(job) => openRun(job.id)}
        footer={
          <>
            <LegendDot tone="success" label="Succeeded" />
            <LegendDot tone="failure" label="Failed" />
            <LegendDot tone="info" label="Waiting" hollow />
          </>
        }
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>No runs</EmptyTitle>
              <EmptyDescription>
                Runs appear here when videos are processed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />

      <RunDialog jobs={data} />
      <VideoDialog />
    </Page>
  )
}

function DailyRuns({ timeline }: { timeline: Stats["timeline"] }) {
  const columns: DotColumn[] = React.useMemo(() => {
    if (timeline.length === 0) return []
    const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const counts = new Map<string, { ok: number; failed: number }>()
    for (const run of timeline) {
      const k = key(new Date(run.createdAt))
      const entry = counts.get(k) ?? { ok: 0, failed: 0 }
      if (run.status === "failed") entry.failed++
      else entry.ok++
      counts.set(k, entry)
    }
    return eachDay(new Date(timeline[0].createdAt), new Date())
      .map((d) => {
        const entry = counts.get(key(d)) ?? { ok: 0, failed: 0 }
        return {
          key: key(d),
          label: formatShortDate(d),
          parts: [
            { tone: "success" as const, count: entry.ok },
            { tone: "failure" as const, count: entry.failed },
          ],
        }
      })
      .slice(-120)
  }, [timeline])

  if (columns.length === 0) return null
  const failed = timeline.filter((r) => r.status === "failed").length
  return (
    <Panel
      title="Runs per day"
      note={`${formatNumber(timeline.length)} runs · ${failed} failed`}
      action={<span className="text-xs text-success">All time</span>}
    >
      <div className="flex flex-col gap-1.5">
        <DotColumns columns={columns} rows={6} />
        <div className="tabular flex justify-between text-xs text-muted-foreground">
          <span>{columns[0].label}</span>
          <span className="text-foreground">
            {columns[columns.length - 1].label}
          </span>
        </div>
      </div>
    </Panel>
  )
}

function buildColumns(
  longest: number,
  openRun: (id: string) => void,
  openVideo: (id: string) => void
): ColumnDef<Job>[] {
  return [
    {
      id: "video",
      header: "Video",
      enableHiding: false,
      accessorFn: (job) => `${job.video?.title ?? ""} ${job.id}`,
      cell: ({ row }) => {
        const job = row.original
        return (
          <VideoCell
            compact
            title={job.video?.title ?? "Deleted video"}
            thumbnailUrl={job.video?.thumbnailUrl ?? null}
            subtitle={`run_${job.id.slice(0, 8)}`}
          />
        )
      },
    },
    {
      id: "kind",
      meta: { label: "Kind" },
      header: "Kind",
      accessorFn: (job) => job.kind,
      filterFn: facetFilter,
      cell: ({ row }) => (
        <span className="text-[13px] text-muted-foreground">
          {kindLabels[row.original.kind]}
        </span>
      ),
    },
    {
      id: "status",
      meta: { label: "Status" },
      header: "Status",
      accessorFn: (job) => job.status,
      filterFn: facetFilter,
      cell: ({ row }) => <JobStatusBadge status={row.original.status} />,
    },
    {
      id: "source",
      meta: { label: "Transcript" },
      header: "Transcript",
      accessorFn: (job) => job.video?.transcriptSource ?? "unknown",
      filterFn: facetFilter,
      cell: ({ getValue }) => (
        <span className="text-[13px] text-muted-foreground">
          {sourceOptions.find((o) => o.value === getValue())?.label ??
            "Unknown"}
        </span>
      ),
    },
    {
      id: "lines",
      meta: { label: "Lines" },
      header: ({ column }) => <SortableHeader column={column} title="Lines" />,
      accessorFn: (job) => Number(job.details.total_segments ?? 0),
      cell: ({ row }) => {
        const total = Number(row.original.details.total_segments ?? 0)
        const done = Number(row.original.details.translated_segments ?? 0)
        if (!total) return <span className="text-muted-foreground">—</span>
        return (
          <StackedMeter
            value={formatNumber(done)}
            suffix={` / ${formatNumber(total)}`}
            percent={(done / total) * 100}
            tone={
              done >= total
                ? "success"
                : isOpenJob(row.original)
                  ? "info"
                  : "failure"
            }
            live={isOpenJob(row.original)}
          />
        )
      },
    },
    {
      id: "duration",
      meta: { label: "Duration" },
      header: ({ column }) => (
        <SortableHeader column={column} title="Duration" />
      ),
      accessorFn: (job) => job.durationMs ?? -1,
      cell: ({ row }) => {
        const job = row.original
        if (isOpenJob(job)) return <RunProgress job={job} />
        return (
          <StackedMeter
            value={
              job.durationMs === null ? job.status : formatMs(job.durationMs)
            }
            percent={((job.durationMs ?? 0) / longest) * 100}
            tone={
              job.status === "failed"
                ? "failure"
                : job.status === "succeeded"
                  ? "success"
                  : "info"
            }
          />
        )
      },
    },
    {
      id: "started",
      meta: { label: "Started" },
      header: ({ column }) => (
        <SortableHeader column={column} title="Started" align="end" />
      ),
      accessorFn: (job) => job.startedAt ?? job.createdAt,
      cell: ({ getValue }) => (
        <WhenCell
          time={formatTime(String(getValue()))}
          date={formatShortDate(String(getValue()))}
        />
      ),
    },
    {
      id: "actions",
      enableHiding: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <RunActions
            job={row.original}
            onView={() => openRun(row.original.id)}
            onOpenVideo={openVideo}
          />
        </div>
      ),
    },
  ]
}

/** Row menu: view, open the video, retry or cancel. */
function RunActions({
  job,
  onView,
  onOpenVideo,
}: {
  job: Job
  onView: () => void
  onOpenVideo: (id: string) => void
}) {
  const request = useRequestRun()
  const cancel = useCancelRun()
  const waiting = job.status === "queued" || job.status === "running"
  const retry = (kind: "process_video" | "retranslate") => {
    if (!job.video) return
    request.mutate(
      { video: job.video.id, kind },
      {
        onSuccess: () => toast.success("Queued"),
        onError: (error) => toast.error(errorMessage(error)),
      }
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Run actions">
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={onView}>
          <SearchIcon />
          View details
        </DropdownMenuItem>
        {job.video && (
          <DropdownMenuItem onSelect={() => onOpenVideo(job.video!.id)}>
            <FilmIcon />
            Open the video
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {waiting ? (
          <DropdownMenuItem
            onSelect={() =>
              cancel.mutate(job.id, {
                onSuccess: () => toast.success("Run cancelled"),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            <XIcon />
            Cancel run
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => retry("process_video")}>
              <RotateCwIcon />
              {job.status === "failed" ? "Retry" : "Run again"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => retry("retranslate")}>
              <LanguagesIcon />
              Retranslate only
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem
          onSelect={() =>
            navigator.clipboard
              .writeText(`${window.location.origin}/processing?run=${job.id}`)
              .then(() => toast.success("Link copied"))
              .catch(() => toast.error("Couldn’t copy"))
          }
        >
          <CopyIcon />
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Opens when the URL has ?run=<id>. */
function RunDialog({ jobs }: { jobs: Job[] }) {
  const url = useTableUrl()
  const openVideo = useOpenVideo()
  const id = url.get("run")
  const job = jobs.find((j) => j.id === id)
  const request = useRequestRun()
  const cancel = useCancelRun()
  const close = () => url.update({ run: null })

  return (
    <Dialog open={Boolean(id)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {!job ? (
          <div className="p-6">
            <DialogTitle>Run not found</DialogTitle>
            <DialogDescription>
              It may have been deleted with its video.
            </DialogDescription>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 border-b px-5 py-3.5 pr-12">
              <DialogTitle className="line-clamp-1 text-base font-medium">
                {job.video?.title ?? "Deleted video"}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-2 font-mono text-xs">
                run_{job.id.slice(0, 8)} · {kindLabels[job.kind]}
                {job.legacy && " · imported from v1"}
              </DialogDescription>
              <div className="flex items-center gap-2">
                <JobStatusBadge status={job.status} />
                <span className="tabular font-mono text-xs text-muted-foreground">
                  took {formatMs(job.durationMs)}
                </span>
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <RunBody job={job} />
            </ScrollArea>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
              {job.video && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openVideo(job.video!.id)}
                >
                  <FilmIcon />
                  Open the video
                </Button>
              )}
              {job.status === "queued" || job.status === "running" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    cancel.mutate(job.id, {
                      onSuccess: () => toast.success("Run cancelled"),
                      onError: (error) => toast.error(errorMessage(error)),
                    })
                  }
                >
                  <XIcon />
                  Cancel run
                </Button>
              ) : (
                job.video && (
                  <Button
                    size="sm"
                    disabled={request.isPending}
                    onClick={() =>
                      request.mutate(
                        { video: job.video!.id, kind: "process_video" },
                        {
                          onSuccess: () => toast.success("Queued"),
                          onError: (error) => toast.error(errorMessage(error)),
                        }
                      )
                    }
                  >
                    <RotateCwIcon />
                    {job.status === "failed" ? "Retry" : "Run again"}
                  </Button>
                )
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RunBody({ job }: { job: Job }) {
  const failed = job.status === "failed"
  const json = JSON.stringify(job.details, null, 2)
  const steps: Array<{
    label: string
    at: string | null
    tone: "success" | "failure" | "muted"
  }> = [
    { label: "Queued", at: job.createdAt, tone: "muted" },
    { label: "Started", at: job.startedAt, tone: "muted" },
    {
      label: failed
        ? job.step && !["failed", "ready"].includes(job.step)
          ? `Failed while ${job.step.replaceAll("_", " ")}`
          : "Failed"
        : job.status === "succeeded"
          ? "Finished"
          : job.status === "cancelled"
            ? "Cancelled"
            : job.status === "running"
              ? String(job.details.stage ?? "Working")
              : "Waiting in the queue",
      at: job.finishedAt,
      tone: failed
        ? "failure"
        : job.status === "succeeded"
          ? "success"
          : "muted",
    },
  ]
  return (
    <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex flex-col gap-3">
        <ol className="flex flex-col gap-3">
          {steps.map((step) => (
            <li key={step.label} className="flex items-start gap-3">
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  step.tone === "success" && "bg-success",
                  step.tone === "failure" && "bg-failure",
                  step.tone === "muted" && "bg-muted-foreground/60"
                )}
              />
              <div className="flex flex-col">
                <span
                  className={cn(
                    "font-mono text-[13px]",
                    step.tone === "failure" && "text-failure"
                  )}
                >
                  {step.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(step.at)}
                </span>
              </div>
            </li>
          ))}
        </ol>
        {isOpenJob(job) && <RunProgress job={job} />}
        {job.requestedBy && (
          <p className="text-xs text-muted-foreground">
            Requested by {job.requestedBy}
          </p>
        )}
        {failed && job.errorMessage && (
          <p className="rounded-lg border border-failure/30 bg-failure/5 p-3 font-mono text-xs break-all text-failure">
            {job.errorMessage}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Details</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy details"
            onClick={() =>
              navigator.clipboard
                .writeText(json)
                .then(() => toast.success("Copied"))
                .catch(() => toast.error("Couldn’t copy"))
            }
          >
            <CopyIcon />
          </Button>
        </div>
        <ScrollArea className="max-h-72 rounded-lg border bg-background">
          <pre className="p-3 font-mono text-xs leading-5">
            {json.split("\n").map((line, index) => (
              <div key={index} className="flex gap-3">
                <span className="tabular w-5 shrink-0 text-right text-muted-foreground/60 select-none">
                  {index + 1}
                </span>
                <span className="break-all whitespace-pre-wrap">
                  <JsonLine line={line} />
                </span>
              </div>
            ))}
          </pre>
        </ScrollArea>
      </div>
    </div>
  )
}

function JsonLine({ line }: { line: string }) {
  const match = line.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/)
  if (!match) return <span className="text-muted-foreground">{line}</span>
  const [, indent, key, colon, value] = match
  const trimmed = value.replace(/,$/, "")
  const comma = value.endsWith(",") ? "," : ""
  const valueClass = trimmed.startsWith('"')
    ? "text-foreground"
    : /^(true|false|null|-?\d)/.test(trimmed)
      ? "text-warning"
      : "text-muted-foreground"
  return (
    <>
      {indent}
      <span className="text-success">{key}</span>
      <span className="text-muted-foreground">{colon}</span>
      <span className={valueClass}>{trimmed}</span>
      <span className="text-muted-foreground">{comma}</span>
    </>
  )
}
