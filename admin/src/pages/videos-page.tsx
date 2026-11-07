import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import {
  CaptionsIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  FileUpIcon,
  FilmIcon,
  HelpCircleIcon,
  MicIcon,
  MoreHorizontalIcon,
} from "lucide-react"

import {
  SourceBadge,
  VideoStatusBadge,
} from "@/components/badges"
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
  type Facet,
} from "@/components/data-table"
import { Page } from "@/components/site-header"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  useOpenVideo,
  VideoActions,
  VideoDialog,
} from "@/components/video-dialog"
import { LegendDot } from "@/components/viz"
import {
  formatHours,
  formatMs,
  formatShortDate,
  formatTime,
} from "@/lib/format"
import { useVideos } from "@/lib/queries"
import type { Video } from "@/lib/types"
import { useTableUrl } from "@/components/data-table"

const statusOptions = [
  { value: "ready", label: "Ready", icon: CircleCheckIcon },
  { value: "failed", label: "Failed", icon: CircleXIcon },
  { value: "queued", label: "Queued", icon: CircleDashedIcon },
  {
    value: "fetching_transcript",
    label: "Fetching captions",
    icon: CircleDashedIcon,
  },
  { value: "transcribing", label: "Transcribing", icon: CircleDashedIcon },
  { value: "translating", label: "Translating", icon: CircleDashedIcon },
]

const sourceOptions = [
  { value: "captions", label: "YouTube captions", icon: CaptionsIcon },
  { value: "asr", label: "Speech to text", icon: MicIcon },
  { value: "uploaded", label: "Uploaded", icon: FileUpIcon },
  { value: "unknown", label: "Unknown", icon: HelpCircleIcon },
]

export function VideosPage() {
  const videos = useVideos()
  const openVideo = useOpenVideo()
  const url = useTableUrl()
  const all = React.useMemo(() => videos.data ?? [], [videos.data])
  const longestRun = Math.max(
    1,
    ...all.map((video) => video.lastJob?.durationMs ?? 0)
  )
  const columns = React.useMemo(
    () => buildColumns(longestRun, openVideo),
    [longestRun, openVideo]
  )

  const facets: Facet[] = React.useMemo(() => {
    const owners = [...new Set(all.map(ownerName))].sort()
    const models = [
      ...new Set(all.map((video) => video.translationModel ?? "none")),
    ].sort()
    return [
      {
        column: "status",
        title: "Status",
        options: statusOptions.filter((o) =>
          all.some((v) => v.status === o.value)
        ),
      },
      {
        column: "source",
        title: "Transcript",
        options: sourceOptions.filter((o) =>
          all.some((v) => (v.transcriptSource ?? "unknown") === o.value)
        ),
      },
      {
        column: "owner",
        title: "Added by",
        options: owners.map((name) => ({ value: name, label: name })),
      },
      {
        column: "model",
        title: "Model",
        options: models.map((model) => ({
          value: model,
          label: model === "none" ? "Not translated" : model,
        })),
      },
    ]
  }, [all])

  const totalMs = all.reduce((sum, video) => sum + (video.durationMs ?? 0), 0)

  return (
    <Page crumbs={[{ label: "Videos" }]} title="Videos">
      <DataTable
        columns={columns}
        data={all}
        loading={videos.isPending}
        facets={facets}
        getRowId={(video) => video.id}
        activeRowId={url.get("video")}
        searchPlaceholder="Search titles, channels, ids"
        onRowClick={(video) => openVideo(video.id)}
        initialSort={{ id: "added", desc: true }}
        initialHidden={["model"]}
        footer={
          <>
            <LegendDot tone="success" label="Done" />
            <LegendDot tone="failure" label="Failed or incomplete" />
            <span className="tabular">
              {formatHours(totalMs)} of video in all
            </span>
          </>
        }
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FilmIcon />
              </EmptyMedia>
              <EmptyTitle>No videos yet</EmptyTitle>
              <EmptyDescription>
                Videos appear when someone adds one in the Vidura app.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
      <VideoDialog />
    </Page>
  )
}

function ownerName(video: Video) {
  return video.owner.name?.split(" ")[0] || video.owner.email
}

function buildColumns(
  longestRun: number,
  openVideo: (id: string) => void
): ColumnDef<Video>[] {
  return [
    {
      id: "video",
      header: "Video",
      enableHiding: false,
      accessorFn: (video) =>
        `${video.title} ${video.channelTitle ?? ""} ${video.youtubeId} ${video.owner.email}`,
      cell: ({ row }) => {
        const video = row.original
        return (
          <VideoCell
            title={video.title}
            thumbnailUrl={video.thumbnailUrl}
            durationMs={video.durationMs}
            subtitle={`${video.youtubeId}${video.channelTitle ? ` · ${video.channelTitle}` : ""}`}
          />
        )
      },
    },
    {
      id: "owner",
      meta: { label: "Added by" },
      header: "Added by",
      accessorFn: ownerName,
      filterFn: facetFilter,
      cell: ({ getValue }) => (
        <span className="text-[13px] text-muted-foreground">
          {String(getValue())}
        </span>
      ),
    },
    {
      id: "status",
      meta: { label: "Status" },
      header: "Status",
      accessorFn: (video) => video.status,
      filterFn: facetFilter,
      cell: ({ row }) => <VideoStatusBadge status={row.original.status} />,
    },
    {
      id: "source",
      meta: { label: "Transcript" },
      header: "Transcript",
      accessorFn: (video) => video.transcriptSource ?? "unknown",
      filterFn: facetFilter,
      cell: ({ row }) => {
        const video = row.original
        return (
          <div className="flex flex-col items-start gap-1">
            <SourceBadge
              source={video.transcriptSource}
              engine={
                video.transcriptSource === "asr" ? video.transcriptEngine : null
              }
            />
            <span className="tabular font-mono text-xs text-muted-foreground">
              {video.qualityScore !== null
                ? `quality ${Math.round(video.qualityScore)}`
                : "not scored"}
            </span>
          </div>
        )
      },
    },
    {
      id: "model",
      meta: { label: "Model" },
      accessorFn: (video) => video.translationModel ?? "none",
      filterFn: facetFilter,
      header: "Model",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {getValue() === "none" ? "—" : String(getValue())}
        </span>
      ),
    },
    {
      id: "translated",
      meta: { label: "Translated" },
      header: ({ column }) => (
        <SortableHeader column={column} title="Translated" />
      ),
      accessorFn: (video) =>
        video.segments > 0 ? video.translated / video.segments : 0,
      cell: ({ row }) => {
        const video = row.original
        const share = video.segments > 0 ? video.translated / video.segments : 0
        return (
          <StackedMeter
            value={video.translated}
            suffix={` / ${video.segments}`}
            percent={share * 100}
            tone={
              share >= 1
                ? "success"
                : isOpenJob(video.lastJob)
                  ? "info"
                  : "failure"
            }
            live={isOpenJob(video.lastJob)}
          />
        )
      },
    },
    {
      id: "processing",
      meta: { label: "Processing" },
      header: ({ column }) => (
        <SortableHeader column={column} title="Processing" />
      ),
      accessorFn: (video) => video.lastJob?.durationMs ?? -1,
      cell: ({ row }) => {
        const job = row.original.lastJob
        if (!job) return <span className="text-muted-foreground">—</span>
        if (isOpenJob(job)) return <RunProgress job={job} />
        return (
          <StackedMeter
            value={
              job.durationMs === null ? job.status : formatMs(job.durationMs)
            }
            percent={((job.durationMs ?? 0) / longestRun) * 100}
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
      id: "added",
      meta: { label: "Added" },
      header: ({ column }) => (
        <SortableHeader column={column} title="Added" align="end" />
      ),
      accessorFn: (video) => video.createdAt,
      cell: ({ row }) => (
        <WhenCell
          time={formatTime(row.original.createdAt)}
          date={formatShortDate(row.original.createdAt)}
        />
      ),
    },
    {
      id: "actions",
      enableHiding: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const video = row.original
        const open = isOpenJob(video.lastJob)
        return (
          <div className="flex justify-end">
            <VideoActions
              videoId={video.id}
              title={video.title}
              youtubeUrl={video.youtubeUrl}
              openRunId={open ? video.lastJob!.id : undefined}
              onView={() => openVideo(video.id)}
              trigger={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${video.title}`}
                >
                  <MoreHorizontalIcon />
                </Button>
              }
            />
          </div>
        )
      },
    },
  ]
}
