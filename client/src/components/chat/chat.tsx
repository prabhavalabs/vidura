import * as React from "react"
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ClapperboardIcon,
  MicIcon,
  RotateCcwIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react"
import { cn } from "cn"
import { Link } from "react-router"
import { toast } from "sonner"

import { Markdown } from "@/components/chat/markdown"
import { VideoChip, VideoPicker } from "@/components/chat/video-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { useAnswerStream } from "@/lib/answer-stream"
import { errorMessage } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import type { ChatMessage, VideoRef } from "@/lib/types"
import { canRecord, MicError, useVoice } from "@/lib/voice"

/** A question on its way to the server, shown until it's saved. */
export type PendingQuestion = {
  question: string
  voice: boolean
  video: VideoRef | null
}

/**
 * A conversation with the tutor: the messages (answers stream in as they're
 * written), quick prompts while it's empty, and a composer that takes typed
 * or spoken questions, with "/" to pick a video to ask about.
 */
export function Chat({
  messages,
  loading,
  pending,
  onAsk,
  onStop,
  onRetry,
  onAnswer,
  seekFor,
  mode,
  videoId,
  defaultVideo = null,
  className,
}: {
  messages: ChatMessage[]
  loading?: boolean
  pending: PendingQuestion | null
  onAsk: (question: PendingQuestion) => Promise<boolean>
  /** Stops the answer being written. */
  onStop: (id: string) => void
  /** Writes a failed or stopped answer again. */
  onRetry: (id: string) => void
  /** A newer copy of an answer, from its stream. Must be stable. */
  onAnswer: (message: ChatMessage) => void
  /** Where an answer's [m:ss] times jump, if anywhere. Must return stable
   * functions. */
  seekFor?: (message: ChatMessage) => ((ms: number) => void) | undefined
  mode: "video" | "library"
  /** The video this conversation is about; the picker leaves it out. */
  videoId?: string
  /** The video the composer starts with attached (a library chat's last). */
  defaultVideo?: VideoRef | null
  className?: string
}) {
  const { t } = useLocale()
  const [draft, setDraft] = React.useState("")
  const [spoken, setSpoken] = React.useState(false)
  // undefined: whatever defaultVideo says; null: removed.
  const [attachedChoice, setAttachedChoice] = React.useState<
    VideoRef | null | undefined
  >(undefined)
  const attached = attachedChoice === undefined ? defaultVideo : attachedChoice
  const [picking, setPicking] = React.useState(false)
  // Where a typed "/" was taken out, to put it back if nothing is picked.
  const slashAt = React.useRef<number | null>(null)
  const input = React.useRef<HTMLTextAreaElement>(null)

  const last = messages.at(-1)
  const answering =
    last?.role === "assistant" && last.status === "streaming" ? last : null

  const scroll = usePinnedScroll()

  const voice = useVoice(
    (text) => {
      if (!text) return
      // Show what was heard so it can be checked, then send it.
      setDraft(text)
      setSpoken(true)
      void send(text, true)
    },
    (error) => {
      if (error instanceof MicError) {
        toast.error(
          error.reason === "blocked" ? t.chat.micBlocked : t.chat.micUnsupported
        )
      } else {
        toast.error(errorMessage(error))
      }
    }
  )

  async function send(text: string, wasSpoken: boolean) {
    const question = text.trim()
    if (!question || pending || answering) return
    setDraft("")
    setSpoken(false)
    scroll.pin()
    const ok = await onAsk({ question, voice: wasSpoken, video: attached })
    if (!ok) {
      // Keep the question so it can be sent again.
      setDraft(question)
      setSpoken(wasSpoken)
    } else if (mode === "video") {
      // In a video's chat, a second video is for one question; in a library
      // chat it stays, so follow-ups are about the same video.
      setAttachedChoice(null)
    }
  }

  function openPicker(at: number | null) {
    slashAt.current = at
    setPicking(true)
  }

  function closePicker({ video, query }: { video?: VideoRef; query: string }) {
    setPicking(false)
    const at = slashAt.current
    slashAt.current = null
    if (video) {
      setAttachedChoice(video)
    } else if (at !== null) {
      // Nothing picked: the "/" was just a character after all.
      const typed = "/" + query
      setDraft((current) => current.slice(0, at) + typed + current.slice(at))
      requestAnimationFrame(() => {
        input.current?.focus()
        input.current?.setSelectionRange(at + typed.length, at + typed.length)
      })
      return
    }
    requestAnimationFrame(() => input.current?.focus())
  }

  const prompts = mode === "video" ? t.chat.promptsVideo : t.chat.promptsLibrary
  const busy =
    Boolean(pending) || Boolean(answering) || voice.state === "understanding"
  const placeholder =
    voice.state === "recording"
      ? t.chat.listening
      : voice.state === "understanding"
        ? t.chat.understanding
        : mode === "video" || attached
          ? t.chat.placeholder
          : t.chat.placeholderLibrary
  const lastId = last?.id

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3", className)}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* The viewport fills the area absolutely: a percentage height
            doesn't resolve through the flex columns around it, and it would
            grow with its content instead of scrolling. Radix's table-display
            wrapper is made a block so long words wrap. */}
        <ScrollArea
          ref={scroll.root}
          className="min-h-0 flex-1 rounded-xl border [&_[data-slot=scroll-area-viewport]>div]:block! [&>[data-slot=scroll-area-viewport]]:absolute [&>[data-slot=scroll-area-viewport]]:inset-0"
        >
          <div ref={scroll.content} className="p-3">
            {loading ? (
              <div className="flex justify-center py-16">
                <Spinner />
              </div>
            ) : messages.length === 0 && !pending ? (
              <div className="flex flex-col items-center justify-center gap-4 px-4 py-10 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <SparklesIcon className="size-5" />
                </span>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {mode === "video" ? t.chat.introVideo : t.chat.introLibrary}{" "}
                  {mode === "library" && t.chat.slashHint}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {prompts.map((prompt) => (
                    <Button
                      key={prompt}
                      variant="outline"
                      size="sm"
                      className="h-auto py-1.5 whitespace-normal"
                      onClick={() => void send(prompt, false)}
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <ol className="flex flex-col gap-4">
                {messages.map((message) =>
                  message.role === "user" ? (
                    <Question key={message.id} message={message} mode={mode} />
                  ) : (
                    <Answer
                      key={message.id}
                      message={message}
                      latest={message.id === lastId}
                      onSeek={seekFor?.(message)}
                      onAnswer={onAnswer}
                      onRetry={onRetry}
                    />
                  )
                )}
                {pending && (
                  <>
                    <Question
                      message={{
                        id: "pending",
                        role: "user",
                        content: pending.question,
                        createdAt: "",
                        voice: pending.voice,
                        status: "done",
                        video: pending.video ?? undefined,
                      }}
                      mode={mode}
                    />
                    <Thinking />
                  </>
                )}
              </ol>
            )}
          </div>
        </ScrollArea>
        {!scroll.atBottom && (
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-md"
            onClick={() => scroll.toBottom()}
            aria-label={t.chat.jumpToLatest}
            title={t.chat.jumpToLatest}
          >
            <ArrowDownIcon />
          </Button>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send(draft, spoken)
        }}
      >
        <VideoPicker open={picking} onClose={closePicker} exclude={videoId}>
          <InputGroup>
            {attached && (
              <InputGroupAddon align="block-start" className="pb-0">
                <VideoChip
                  video={attached}
                  label={mode === "video" ? t.chat.alsoAbout : undefined}
                  onRemove={() => setAttachedChoice(null)}
                />
              </InputGroupAddon>
            )}
            <InputGroupTextarea
              ref={input}
              value={draft}
              onChange={(event) => {
                const next = event.target.value
                const caret = event.target.selectionStart
                // A "/" typed at the start or after a space opens the
                // picker. This reads the change rather than the key, since
                // phone keyboards don't report which key was pressed.
                if (
                  !(event.nativeEvent as InputEvent).isComposing &&
                  next.length === draft.length + 1 &&
                  caret > 0 &&
                  next[caret - 1] === "/" &&
                  (caret === 1 || /\s/.test(next[caret - 2])) &&
                  next.slice(0, caret - 1) + next.slice(caret) === draft
                ) {
                  openPicker(caret - 1)
                  return
                }
                setDraft(next)
                if (!next) setSpoken(false)
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  void send(draft, spoken)
                }
              }}
              placeholder={placeholder}
              disabled={voice.state !== "idle"}
              rows={1}
              maxLength={2000}
              className="max-h-40 min-h-11"
              aria-label={placeholder}
            />
            <InputGroupAddon align="block-end" className="justify-between">
              <div className="flex items-center gap-1">
                <InputGroupButton
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => openPicker(null)}
                  disabled={voice.state !== "idle"}
                  aria-label={t.chat.attachVideo}
                  title={t.chat.attachVideo}
                >
                  <ClapperboardIcon />
                </InputGroupButton>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {voice.state === "recording" &&
                    `● ${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, "0")}`}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {canRecord() &&
                  (voice.state === "recording" ? (
                    <InputGroupButton
                      variant="destructive"
                      size="sm"
                      onClick={voice.stop}
                      aria-label={t.chat.stop}
                    >
                      <SquareIcon className="fill-current" />
                      {t.chat.stop}
                    </InputGroupButton>
                  ) : (
                    <InputGroupButton
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => void voice.start()}
                      disabled={busy}
                      aria-label={t.chat.voice}
                    >
                      {voice.state === "understanding" ? (
                        <Spinner />
                      ) : (
                        <MicIcon />
                      )}
                    </InputGroupButton>
                  ))}
                {answering ? (
                  <InputGroupButton
                    size="icon-sm"
                    variant="default"
                    className="rounded-full"
                    onClick={() => onStop(answering.id)}
                    aria-label={t.chat.stopAnswer}
                    title={t.chat.stopAnswer}
                  >
                    <SquareIcon className="size-3 fill-current" />
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    type="submit"
                    size="icon-sm"
                    variant="default"
                    className="rounded-full"
                    disabled={!draft.trim() || busy || voice.state !== "idle"}
                    aria-label={t.chat.send}
                  >
                    {pending ? <Spinner /> : <ArrowUpIcon />}
                  </InputGroupButton>
                )}
              </div>
            </InputGroupAddon>
          </InputGroup>
        </VideoPicker>
      </form>
    </div>
  )
}

/**
 * Keeps the conversation scrolled to the newest text while the reader is at
 * the bottom; once they scroll up to read, it stays where they are.
 */
function usePinnedScroll() {
  const root = React.useRef<HTMLDivElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const pinned = React.useRef(true)
  const [atBottom, setAtBottom] = React.useState(true)

  const viewport = React.useCallback(
    () =>
      root.current?.querySelector<HTMLElement>(
        "[data-slot=scroll-area-viewport]"
      ) ?? null,
    []
  )

  React.useEffect(() => {
    const view = viewport()
    const body = content.current
    if (!view || !body) return
    // Only the reader scrolling up lets go of the bottom. A scroll event
    // can arrive after more text has already grown the list (it's handled
    // a frame later), so "far from the bottom" alone doesn't mean the
    // reader moved; moving up does, and growing never moves up.
    let lastTop = view.scrollTop
    const onScroll = () => {
      const gap = view.scrollHeight - view.scrollTop - view.clientHeight
      if (view.scrollTop < lastTop - 1) pinned.current = gap < 48
      else if (gap < 48) pinned.current = true
      lastTop = view.scrollTop
      setAtBottom(pinned.current || gap < 48)
    }
    // Growth (a new message, more of an answer) follows the bottom only
    // while pinned.
    const observer = new ResizeObserver(() => {
      if (pinned.current) view.scrollTop = view.scrollHeight
      else
        setAtBottom(view.scrollHeight - view.scrollTop - view.clientHeight < 48)
    })
    view.addEventListener("scroll", onScroll, { passive: true })
    observer.observe(body)
    view.scrollTop = view.scrollHeight
    return () => {
      view.removeEventListener("scroll", onScroll)
      observer.disconnect()
    }
  }, [viewport])

  const toBottom = React.useCallback(
    (smooth = true) => {
      const view = viewport()
      pinned.current = true
      setAtBottom(true)
      view?.scrollTo({
        top: view.scrollHeight,
        behavior: smooth ? "smooth" : "auto",
      })
    },
    [viewport]
  )
  const pin = React.useCallback(() => toBottom(false), [toBottom])

  return { root, content, atBottom, toBottom, pin }
}

const Question = React.memo(function Question({
  message,
  mode,
}: {
  message: ChatMessage
  mode: "video" | "library"
}) {
  const { t } = useLocale()
  return (
    <li className="flex flex-col items-end gap-1">
      {message.video && (
        <Link
          to={`/watch/${message.video.id}`}
          className="max-w-[85%] min-w-0 rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <VideoChip
            video={message.video}
            label={mode === "video" ? t.chat.alsoAbout : undefined}
            className="hover:bg-secondary/80"
          />
        </Link>
      )}
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 whitespace-pre-wrap text-primary-foreground">
        {message.content}
      </div>
      {message.voice && (
        <Badge variant="outline" className="text-muted-foreground">
          <MicIcon />
          {t.chat.spoken}
        </Badge>
      )}
    </li>
  )
})

const Answer = React.memo(function Answer({
  message,
  latest,
  onSeek,
  onAnswer,
  onRetry,
}: {
  message: ChatMessage
  latest: boolean
  onSeek?: (ms: number) => void
  onAnswer: (message: ChatMessage) => void
  onRetry: (id: string) => void
}) {
  const { t } = useLocale()
  const { text } = useAnswerStream(message, onAnswer)
  const streaming = message.status === "streaming"

  if (streaming && !text) return <Thinking />
  return (
    <li className="flex max-w-[95%] flex-col items-start gap-1.5">
      {text && (
        <div
          className="rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5"
          aria-busy={streaming}
        >
          <Markdown text={text} onSeek={onSeek} />
        </div>
      )}
      {(message.status === "failed" || message.status === "stopped") && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm",
            message.status === "failed"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
          role={message.status === "failed" ? "alert" : undefined}
        >
          {message.status === "failed" && (
            <AlertCircleIcon className="size-4 shrink-0" />
          )}
          <span>
            {message.status === "failed"
              ? (t.chat.errors[message.error ?? "failed"] ??
                t.chat.errors.failed)
              : t.chat.stopped}
          </span>
          {latest && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onRetry(message.id)}
            >
              <RotateCcwIcon />
              {t.chat.retry}
            </Button>
          )}
        </div>
      )}
    </li>
  )
})

/** Before the first words of an answer arrive. */
function Thinking() {
  const { t } = useLocale()
  return (
    <li
      className="flex items-center gap-2 px-1 text-sm text-muted-foreground"
      role="status"
    >
      <span className="flex gap-1" aria-hidden>
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      {t.chat.thinking}
    </li>
  )
}
