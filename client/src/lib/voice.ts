import * as React from "react"

import { ApiError, apiUrl } from "@/lib/api"

// Recording a spoken question and turning it into text (on the owner's Mac,
// through the API).

const MAX_SECONDS = 90

// Browsers record different formats: Chrome and Firefox WebM/Ogg (Opus),
// Safari MP4 (AAC). The first one supported is used.
const FORMATS = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/aac",
]

export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    "MediaRecorder" in window &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  )
}

export type RecorderState = "idle" | "recording" | "understanding"

export class MicError extends Error {
  readonly reason: "blocked" | "unsupported"

  constructor(reason: "blocked" | "unsupported") {
    super(reason)
    this.reason = reason
  }
}

/** Sends a recording to the API; returns the words and their language. */
async function understand(
  blob: Blob
): Promise<{ text: string; language: string }> {
  const type = blob.type.split(";")[0] || "audio/webm"
  const response = await fetch(`${apiUrl}/api/voice`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": type },
    body: blob,
  })
  const data = (await response.json().catch(() => null)) as {
    text?: string
    language?: string
    error?: { code?: string; message?: string }
  } | null
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error?.code ?? "http_error",
      data?.error?.message ?? `Request failed (${response.status})`
    )
  }
  return { text: data?.text ?? "", language: data?.language ?? "" }
}

/**
 * Records from the microphone. start() asks for permission and records;
 * stop() ends the recording and resolves with what was said.
 */
export function useVoice(
  onText: (text: string) => void,
  onError: (error: unknown) => void
) {
  const [state, setState] = React.useState<RecorderState>("idle")
  const [seconds, setSeconds] = React.useState(0)
  const recorder = React.useRef<MediaRecorder | null>(null)
  const chunks = React.useRef<Blob[]>([])
  const timer = React.useRef<number | undefined>(undefined)
  const handlers = React.useRef({ onText, onError })
  React.useEffect(() => {
    handlers.current = { onText, onError }
  })

  const cleanup = React.useCallback(() => {
    window.clearInterval(timer.current)
    recorder.current?.stream.getTracks().forEach((track) => track.stop())
    recorder.current = null
  }, [])

  React.useEffect(() => cleanup, [cleanup])

  const stop = React.useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop()
  }, [])

  const start = React.useCallback(async () => {
    if (!canRecord()) {
      handlers.current.onError(new MicError("unsupported"))
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch {
      handlers.current.onError(new MicError("blocked"))
      return
    }
    const mimeType = FORMATS.find((f) => MediaRecorder.isTypeSupported(f))
    const media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunks.current = []
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data)
    }
    media.onstop = async () => {
      const blob = new Blob(chunks.current, { type: media.mimeType })
      cleanup()
      if (blob.size < 1000) {
        setState("idle")
        return
      }
      setState("understanding")
      try {
        const { text } = await understand(blob)
        handlers.current.onText(text)
      } catch (error) {
        handlers.current.onError(error)
      } finally {
        setState("idle")
      }
    }
    recorder.current = media
    media.start()
    setSeconds(0)
    setState("recording")
    const startedAt = Date.now()
    timer.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000)
      setSeconds(elapsed)
      if (elapsed >= MAX_SECONDS) stop()
    }, 250)
  }, [cleanup, stop])

  return { state, seconds, start, stop }
}
