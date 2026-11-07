import * as React from "react"

import { ApiError, apiUrl } from "@/lib/api"
import type { ChatMessage } from "@/lib/types"

// A tutor answer is written on the server, detached from the request that
// asked. While it's being written, GET /api/messages/{id}/stream sends it as
// Server-Sent Events:
//
//   event: snapshot  data: {"text": the whole answer so far}
//   event: delta     data: {"text": more of it}
//   event: end       data: {"message": the finished answer}
//
// (and ": ping" comments while it's quiet). Reconnecting starts again from a
// snapshot, so leaving and coming back loses nothing. fetch() is used rather
// than EventSource so a 404 or a sign-out is seen and not retried forever,
// and so the reading stops exactly when the component asks.

export type AnswerEvent =
  | { type: "snapshot"; text: string }
  | { type: "delta"; text: string }
  | { type: "end"; message: ChatMessage }

/** Reads an answer's events until it ends, the connection drops, or signal
 * aborts. Resolves true when the end event arrived. */
export async function readAnswer(
  id: string,
  signal: AbortSignal,
  onEvent: (event: AnswerEvent) => void
): Promise<boolean> {
  const response = await fetch(`${apiUrl}/api/messages/${id}/stream`, {
    credentials: "include",
    cache: "no-store",
    signal,
  })
  if (!response.ok || !response.body) {
    let message = `Request failed (${response.status})`
    let code = "http_error"
    try {
      const data = (await response.json()) as {
        error?: { code?: string; message?: string }
      }
      message = data.error?.message ?? message
      code = data.error?.code ?? code
    } catch {
      // Not JSON; keep the status.
    }
    throw new ApiError(response.status, code, message)
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return false
      buffer += value
      // Events end with a blank line.
      let boundary = buffer.search(/\r?\n\r?\n/)
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "")
        const event = parse(block)
        if (event) {
          onEvent(event)
          if (event.type === "end") return true
        }
        boundary = buffer.search(/\r?\n\r?\n/)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parse(block: string): AnswerEvent | null {
  let type = "message"
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "event") type = value
    else if (field === "data") data.push(value)
  }
  if (data.length === 0) return null
  try {
    const payload = JSON.parse(data.join("\n")) as {
      text?: string
      message?: ChatMessage
    }
    if (type === "snapshot" || type === "delta") {
      return { type, text: payload.text ?? "" }
    }
    if (type === "end" && payload.message) {
      return { type: "end", message: payload.message }
    }
  } catch {
    // A malformed event is skipped; the end event settles the answer.
  }
  return null
}

function useVisible() {
  return React.useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange)
      return () => document.removeEventListener("visibilitychange", onChange)
    },
    () => document.visibilityState === "visible",
    () => true
  )
}

/**
 * The live text of an answer being written. It follows the stream while the
 * page is visible (a hidden page lets go, so the server knows to notify, and
 * picks up again from a snapshot when shown), reconnects after a dropped
 * connection, and calls onEnd with the finished answer.
 *
 * Text arriving in bursts is applied at most once per frame, so a fast
 * model doesn't re-render the conversation for every token.
 */
export function useAnswerStream(
  message: ChatMessage,
  onEnd: (message: ChatMessage) => void
): { text: string; connected: boolean } {
  const streaming = message.status === "streaming"
  const visible = useVisible()
  const [text, setText] = React.useState(message.content)
  const [connected, setConnected] = React.useState(false)
  // A retried answer streams again from what the server has (nothing yet).
  const [wasStreaming, setWasStreaming] = React.useState(streaming)
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming)
    if (streaming) setText(message.content)
  }
  const end = React.useRef(onEnd)
  const latest = React.useRef(message)
  React.useEffect(() => {
    end.current = onEnd
    latest.current = message
  })

  React.useEffect(() => {
    if (!streaming || !visible) return
    const abort = new AbortController()
    let live = ""
    let frame = 0
    const flush = () => {
      frame = 0
      setText(live)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush)
    }
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      readAnswer(message.id, abort.signal, (event) => {
        attempt = 0
        setConnected(true)
        if (event.type === "snapshot") {
          live = event.text
          schedule()
        } else if (event.type === "delta") {
          live += event.text
          schedule()
        } else {
          if (frame) cancelAnimationFrame(frame)
          frame = 0
          setText(event.message.content)
          end.current(event.message)
        }
      })
        .then((ended) => {
          if (!ended && !abort.signal.aborted) retry()
        })
        .catch((error: unknown) => {
          if (abort.signal.aborted) return
          setConnected(false)
          // The answer (or the session) is gone: there's nothing to
          // follow, so show it as failed rather than thinking forever.
          if (error instanceof ApiError && error.status < 500) {
            end.current({
              ...latest.current,
              status: "failed",
              error: "failed",
            })
            return
          }
          retry()
        })
    }
    const retry = () => {
      setConnected(false)
      attempt += 1
      retryTimer = setTimeout(
        connect,
        Math.min(1000 * 2 ** (attempt - 1), 10_000)
      )
    }
    connect()
    return () => {
      abort.abort()
      if (frame) cancelAnimationFrame(frame)
      if (retryTimer) clearTimeout(retryTimer)
      setConnected(false)
    }
  }, [message.id, streaming, visible])

  return { text: streaming ? text : message.content, connected }
}
