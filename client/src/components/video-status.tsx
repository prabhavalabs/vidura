import { AlertCircleIcon, CheckCircle2Icon, ClockIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { useT, type Messages } from "@/lib/i18n"
import { isProcessing } from "@/lib/queries"
import type { Video } from "@/lib/types"

/** What's happening to a video right now, in a few words. */
export function stageLabel(video: Video, t: Messages): string {
  if (video.lastJob?.status === "queued") return t.status.stages.queued
  return t.status.stages[video.status] ?? t.status.working
}

/** One badge for the video's single current status. */
export function VideoStatusBadge({ video }: { video: Video }) {
  const t = useT()
  if (isProcessing(video)) {
    const queued = video.lastJob?.status === "queued"
    return (
      <Badge variant="secondary">
        {queued ? <ClockIcon /> : <Spinner />}
        {queued ? t.status.waiting : `${video.lastJob?.progress ?? 0}%`}
      </Badge>
    )
  }
  if (video.status === "failed") {
    return (
      <Badge variant="destructive">
        <AlertCircleIcon />
        {t.status.failed}
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <CheckCircle2Icon />
      {t.status.ready}
    </Badge>
  )
}

/** A progress bar with the current stage, for a video being processed. */
export function VideoProgress({ video }: { video: Video }) {
  const t = useT()
  const progress = video.lastJob?.progress ?? 0
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Spinner />
          {stageLabel(video, t)}
        </span>
        <span className="font-medium tabular-nums">{progress}%</span>
      </div>
      <Progress value={progress} aria-label={t.status.progress} />
    </div>
  )
}
