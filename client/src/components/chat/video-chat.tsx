import * as React from "react"
import { toast } from "sonner"

import { Chat, type PendingQuestion } from "@/components/chat/chat"
import { ApiError, errorMessage } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import {
  putMessage,
  useAsk,
  useRetryAnswer,
  useStopAnswer,
  useVideoChat,
} from "@/lib/queries"
import type { ChatMessage } from "@/lib/types"

/** The tutor for one video: its conversation, with times that jump the video. */
export function VideoChat({
  videoId,
  onSeek,
}: {
  videoId: string
  onSeek: (ms: number) => void
}) {
  const { t, locale } = useLocale()
  const conversation = useVideoChat(videoId)
  const ask = useAsk(videoId)
  const place = React.useMemo(() => ({ videoId }), [videoId])
  const stop = useStopAnswer(place)
  const retry = useRetryAnswer(place)
  const [pending, setPending] = React.useState<PendingQuestion | null>(null)

  const onAnswer = React.useCallback(
    (message: ChatMessage) => putMessage(place, message),
    [place]
  )
  const seekFor = React.useCallback(() => onSeek, [onSeek])

  return (
    <Chat
      mode="video"
      videoId={videoId}
      messages={conversation.data?.messages ?? []}
      loading={conversation.isPending}
      pending={pending}
      seekFor={seekFor}
      onAnswer={onAnswer}
      onStop={(id) =>
        stop.mutate(id, {
          onError: (error) => toast.error(errorMessage(error)),
        })
      }
      onRetry={(id) =>
        retry.mutate(
          { id, locale },
          { onError: (error) => toast.error(errorMessage(error)) }
        )
      }
      onAsk={async ({ question, voice, video }) => {
        setPending({ question, voice, video })
        try {
          await ask.mutateAsync({
            question,
            voice,
            locale,
            attachedVideoId: video?.id,
          })
          return true
        } catch (error) {
          toast.error(
            error instanceof ApiError && error.code === "answering"
              ? t.chat.answering
              : errorMessage(error)
          )
          return false
        } finally {
          setPending(null)
        }
      }}
    />
  )
}
