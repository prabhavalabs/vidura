import {
  CaptionsIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  FileUpIcon,
  LoaderIcon,
  MicIcon,
} from "lucide-react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import type { JobStatus, TranscriptSource, VideoStatus } from "@/lib/types"

const videoStatus: Record<
  VideoStatus,
  { label: string; className: string; busy?: boolean }
> = {
  ready: {
    label: "Ready",
    className: "border-success/30 bg-success/10 text-success",
  },
  failed: {
    label: "Failed",
    className: "border-failure/30 bg-failure/10 text-failure",
  },
  queued: {
    label: "Queued",
    className: "border-dashed text-muted-foreground",
  },
  fetching_transcript: {
    label: "Fetching captions",
    className: "border-dashed border-info/50 text-info",
    busy: true,
  },
  transcribing: {
    label: "Transcribing",
    className: "border-dashed border-info/50 text-info",
    busy: true,
  },
  translating: {
    label: "Translating",
    className: "border-dashed border-info/50 text-info",
    busy: true,
  },
}

export function VideoStatusBadge({ status }: { status: VideoStatus }) {
  const style = videoStatus[status] ?? videoStatus.queued
  return (
    <Badge variant="outline" className={cn("font-mono", style.className)}>
      {style.busy ? (
        <LoaderIcon className="animate-spin" />
      ) : status === "queued" ? (
        <CircleDashedIcon />
      ) : null}
      {style.label}
    </Badge>
  )
}

const jobStatus: Record<
  JobStatus,
  { label: string; className: string; icon: React.ReactNode }
> = {
  succeeded: {
    label: "Succeeded",
    className: "border-success/30 bg-success/10 text-success",
    icon: <CircleCheckIcon />,
  },
  failed: {
    label: "Failed",
    className: "border-failure/30 bg-failure/10 text-failure",
    icon: <CircleXIcon />,
  },
  running: {
    label: "Running",
    className: "border-dashed border-info/50 text-info",
    icon: <LoaderIcon className="animate-spin" />,
  },
  queued: {
    label: "Queued",
    className: "border-dashed text-muted-foreground",
    icon: <CircleDashedIcon />,
  },
  cancelled: {
    label: "Cancelled",
    className: "text-muted-foreground",
    icon: <CircleXIcon />,
  },
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const style = jobStatus[status] ?? jobStatus.queued
  return (
    <Badge variant="outline" className={cn("font-mono", style.className)}>
      {style.icon}
      {style.label}
    </Badge>
  )
}

/** How the English transcript was obtained. */
export function SourceBadge({
  source,
  engine,
}: {
  source: TranscriptSource | string | null
  engine?: string | null
}) {
  if (!source) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Unknown
      </Badge>
    )
  }
  const meta =
    source === "captions"
      ? { label: "Captions", icon: <CaptionsIcon /> }
      : source === "asr"
        ? { label: "Speech to text", icon: <MicIcon /> }
        : source === "uploaded"
          ? { label: "Uploaded", icon: <FileUpIcon /> }
          : { label: source, icon: null }
  return (
    <Badge variant="secondary" className="gap-1.5">
      {meta.icon}
      {meta.label}
      {engine && (
        <span className="font-mono text-muted-foreground">· {engine}</span>
      )}
    </Badge>
  )
}

export function sourceLabel(source: string): string {
  return source === "captions"
    ? "YouTube captions"
    : source === "asr"
      ? "Speech to text"
      : source === "uploaded"
        ? "Uploaded"
        : "Unknown"
}
