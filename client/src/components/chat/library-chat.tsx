import * as React from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Chat, type PendingQuestion } from "@/components/chat/chat"
import { ApiError, errorMessage } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import {
  putMessage,
  useAsk,
  useChat,
  useRetryAnswer,
  useStopAnswer,
} from "@/lib/queries"
import type { ChatMessage } from "@/lib/types"

/**
 * A conversation about the whole library (threadId), or a new one. A video
 * picked with "/" scopes the question to that video, and stays attached for
 * follow-ups; its answer's [m:ss] times open the video at that moment.
 */
export function LibraryChat({
  threadId,
  onThreadCreated,
}: {
  threadId?: string
  /** A new conversation was saved under this id. */
  onThreadCreated: (id: string) => void
}) {
  const { t, locale } = useLocale()
  const navigate = useNavigate()
  const chat = useChat(threadId)
  const ask = useAsk()
  const place = React.useMemo(() => ({ threadId: threadId ?? "" }), [threadId])
  const stop = useStopAnswer(place)
  const retry = useRetryAnswer(place)
  const [pending, setPending] = React.useState<PendingQuestion | null>(null)

  const messages = React.useMemo(
    () => (threadId ? (chat.data?.messages ?? []) : []),
    [threadId, chat.data]
  )
  // The composer starts with the video the last question was about.
  const defaultVideo = React.useMemo(
    () => messages.findLast((m) => m.role === "user")?.video ?? null,
    [messages]
  )
  const videoIds = [
    ...new Set(messages.flatMap((m) => (m.video ? [m.video.id] : []))),
  ].join(",")
  const seekers = React.useMemo(() => {
    const map = new Map<string, (ms: number) => void>()
    for (const id of videoIds.split(",").filter(Boolean)) {
      map.set(id, (ms) => navigate(`/watch/${id}?t=${ms}`))
    }
    return map
  }, [videoIds, navigate])
  const seekFor = React.useCallback(
    (message: ChatMessage) =>
      message.video ? seekers.get(message.video.id) : undefined,
    [seekers]
  )
  const onAnswer = React.useCallback(
    (message: ChatMessage) => putMessage(place, message),
    [place]
  )

  return (
    <Chat
      mode="library"
      messages={messages}
      loading={Boolean(threadId) && chat.isPending}
      pending={pending}
      defaultVideo={defaultVideo}
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
          const result = await ask.mutateAsync({
            question,
            voice,
            locale,
            threadId,
            attachedVideoId: video?.id,
          })
          if (!threadId) onThreadCreated(result.thread.id)
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
