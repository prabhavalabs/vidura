// Table cells shared by the Videos and Processing tables, so the same kind
// of value always looks and lines up the same way.
import { CircleDashedIcon, LoaderIcon } from "lucide-react"
import { cn } from "cn"

import { Meter, type Tone } from "@/components/viz"
import { formatClock } from "@/lib/format"
import type { JobSummary } from "@/lib/types"

/**
 * A value on top and a progress bar under it, both the same width, so
 * columns of these line up exactly.
 */
export function StackedMeter({
  value,
  suffix,
  percent,
  tone,
  icon,
  live,
}: {
  value: React.ReactNode
  suffix?: React.ReactNode
  percent: number
  tone: Tone
  icon?: React.ReactNode
  live?: boolean
}) {
  return (
    <div className="flex w-32 flex-col gap-1.5">
      <span className="tabular flex min-w-0 items-center gap-1 font-mono text-[13px] leading-none [&_svg]:size-3 [&_svg]:shrink-0">
        {icon}
        <span className="truncate">
          {value}
          {suffix && <span className="text-muted-foreground">{suffix}</span>}
        </span>
      </span>
      <Meter value={percent} tone={tone} live={live} />
    </div>
  )
}

/** What a running job is doing right now. */
export const stepLabels: Record<string, string> = {
  captions: "captions",
  transcribe: "speech to text",
  context: "glossary",
  translate: "translating",
  verify: "checking",
}

/** True while a run is waiting or working. */
export function isOpenJob(job: JobSummary | null | undefined): boolean {
  return !!job && (job.status === "queued" || job.status === "running")
}

/** Live progress of a waiting or running job, in the StackedMeter layout. */
export function RunProgress({ job }: { job: JobSummary }) {
  if (job.status === "queued") {
    return (
      <StackedMeter
        icon={<CircleDashedIcon className="text-muted-foreground" />}
        value="queued"
        suffix=" · waiting"
        percent={0}
        tone="muted"
        live
      />
    )
  }
  return (
    <StackedMeter
      icon={<LoaderIcon className="animate-spin text-info" />}
      value={`${job.progress}%`}
      suffix={` · ${(job.step && stepLabels[job.step]) || "starting"}`}
      percent={job.progress}
      tone="info"
      live
    />
  )
}

/** Thumbnail with length, title, and a mono line under it. */
export function VideoCell({
  title,
  thumbnailUrl,
  durationMs,
  subtitle,
  compact,
}: {
  title: string
  thumbnailUrl: string | null
  durationMs?: number | null
  subtitle: React.ReactNode
  compact?: boolean
}) {
  return (
    <div className="flex min-w-60 items-center gap-3">
      <div
        className={cn(
          "relative aspect-video shrink-0 overflow-hidden rounded-md bg-muted",
          compact ? "w-16" : "w-20"
        )}
      >
        {thumbnailUrl && (
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        )}
        {durationMs !== null && durationMs !== undefined && !compact && (
          <span className="tabular absolute right-0.5 bottom-0.5 rounded bg-black/75 px-1 font-mono text-[10px] leading-4 text-white">
            {formatClock(durationMs)}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="line-clamp-1 max-w-md text-[13px] font-medium whitespace-normal">
          {title}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {subtitle}
        </span>
      </div>
    </div>
  )
}

/** A time over a date, right-aligned. */
export function WhenCell({ time, date }: { time: string; date: string }) {
  return (
    <div className="tabular flex flex-col items-end font-mono text-[13px] leading-tight">
      <span>{time}</span>
      <span className="text-xs text-muted-foreground">{date}</span>
    </div>
  )
}
