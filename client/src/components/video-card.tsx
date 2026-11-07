import { Link } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { VideoCardActions } from "@/components/video-actions"
import { VideoStatusBadge } from "@/components/video-status"
import { ago, clock } from "@/lib/format"
import { useLocale } from "@/lib/i18n"
import { isProcessing } from "@/lib/queries"
import type { Video } from "@/lib/types"

export function VideoCard({ video }: { video: Video }) {
  const { locale } = useLocale()
  const processing = isProcessing(video)
  return (
    <VideoCardActions video={video}>
      <Card className="group h-full gap-0 overflow-hidden py-0 transition-shadow select-none [-webkit-touch-callout:none] focus-within:ring-3 focus-within:ring-ring/50 hover:shadow-md">
        <Link
          to={`/watch/${video.id}`}
          className="flex h-full flex-col outline-none"
          aria-label={video.title}
        >
          <div className="relative aspect-video overflow-hidden bg-muted">
            {video.thumbnailUrl && (
              <img
                src={video.thumbnailUrl}
                alt=""
                loading="lazy"
                className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
              />
            )}
            {video.durationMs != null && (
              <Badge className="absolute right-2 bottom-2 bg-black/75 text-white tabular-nums">
                {clock(video.durationMs)}
              </Badge>
            )}
            {processing && (
              <Progress
                value={video.lastJob?.progress ?? 0}
                className="absolute inset-x-0 bottom-0 h-1 rounded-none"
                aria-label="Progress"
              />
            )}
          </div>
          <CardContent className="flex flex-1 flex-col gap-2 p-4">
            <h3 className="line-clamp-2 leading-snug font-medium">
              {video.title}
            </h3>
            <div className="mt-auto flex items-center justify-between gap-2 text-sm text-muted-foreground">
              <span className="truncate">
                {video.channelTitle ?? "YouTube"} ·{" "}
                {ago(video.createdAt, locale)}
              </span>
              <VideoStatusBadge video={video} />
            </div>
          </CardContent>
        </Link>
      </Card>
    </VideoCardActions>
  )
}
