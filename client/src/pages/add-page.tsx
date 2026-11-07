import * as React from "react"
import { LinkIcon } from "lucide-react"
import { useNavigate, useSearchParams } from "react-router"
import { toast } from "sonner"

import { AddVideoForm } from "@/components/add-video-form"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { useAddVideo } from "@/lib/queries"

// A YouTube watch, short, live or youtu.be link anywhere in a piece of text.
const YOUTUBE_LINK =
  /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{11}[^\s]*/i

/** The first YouTube link in what another app shared. */
function sharedYouTubeLink(params: URLSearchParams): string | null {
  for (const name of ["url", "text", "title"]) {
    const match = params.get(name)?.match(YOUTUBE_LINK)
    if (match) return match[0]
  }
  return null
}

/**
 * Adding a video. The installed app opens this page from its "Add video"
 * shortcut, and when someone shares a link to Vidura from YouTube or the
 * browser (the manifest's share_target sends it as ?url=… or inside ?text=…).
 * A shared link is added at once and its watch page opens.
 */
export function AddPage() {
  const t = useT()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const add = useAddVideo()
  const shared = params.has("url") || params.has("text") || params.has("title")
  const link = sharedYouTubeLink(params)
  const started = React.useRef(false)

  const { mutate } = add
  React.useEffect(() => {
    // Once, even under StrictMode's double effects.
    if (!link || started.current) return
    started.current = true
    mutate(link, {
      onSuccess: (result) => {
        if (!result.created) toast(t.add.already)
        navigate(`/watch/${result.video.id}`, { replace: true })
      },
      onError: (error) => toast.error(errorMessage(error)),
    })
  }, [link, mutate, navigate, t])

  if (link && !add.isError) {
    return (
      <div className="flex min-h-[40svh] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Spinner className="size-6" />
        {t.share.adding}
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          {t.share.title}
        </h1>
        <p className="text-sm text-muted-foreground">{t.share.subtitle}</p>
      </div>
      {shared && !link && (
        <Alert>
          <LinkIcon />
          <AlertDescription>{t.share.noLink}</AlertDescription>
        </Alert>
      )}
      <AddVideoForm />
    </div>
  )
}
