// Shapes of the API's JSON, mirroring the Go types in internal/catalog and
// internal/auth.

export type User = {
  id: string
  email: string
  name: string
  imageUrl: string | null
  role: "superuser" | "member"
  status: "active" | "disabled"
  locale: "en" | "si"
}

export type VideoStatus =
  | "queued"
  | "fetching_transcript"
  | "transcribing"
  | "translating"
  | "ready"
  | "failed"

export type JobStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled"

export type JobKind = "process_video" | "retranslate" | "retranscribe"

export type JobSummary = {
  id: string
  kind: JobKind
  status: JobStatus
  step: string | null
  progress: number
  durationMs: number | null
  startedAt: string | null
  finishedAt: string | null
}

export type Job = JobSummary & {
  attempts: number
  errorMessage: string | null
  details: {
    stage?: string
    total_segments?: number
    translated_segments?: number
  } | null
  createdAt: string
}

export type Video = {
  id: string
  youtubeId: string
  youtubeUrl: string
  title: string
  channelTitle: string | null
  thumbnailUrl: string | null
  durationMs: number | null
  targetLanguage: string
  status: VideoStatus
  errorMessage: string | null
  transcriptSource: "captions" | "asr" | "uploaded" | null
  qualityScore: number | null
  segments: number
  translated: number
  lastJob: JobSummary | null
  createdAt: string
  updatedAt: string
}

export type Segment = {
  index: number
  startMs: number
  endMs: number
  text: string
  translation: string | null
}

export type VideoDetail = {
  video: Video
  segments: Segment[]
  jobs: Job[]
}

export type Added = {
  video: Video
  job: Job | null
  created: boolean
}

export type LibraryFilter = "all" | "ready" | "processing" | "failed"

export type LibraryParams = {
  q: string
  filter: LibraryFilter
  page: number
  size: number
}

export type LibraryPage = {
  videos: Video[]
  page: number
  size: number
  total: number
  counts: Record<LibraryFilter, number>
}

// --- learning ---------------------------------------------------------------

export type InsightKind = "summary" | "flashcards" | "quiz"

export type Insight<T = unknown> = {
  kind: InsightKind
  locale: "en" | "si"
  status: "none" | "pending" | "ready" | "failed"
  content?: T
  error?: string
  updatedAt?: string
}

export type Summary = {
  title: string
  overview: string
  sections: { heading: string; points: string[]; startMs: number }[]
  takeaways: string[]
  terms: { term: string; meaning: string }[]
}

export type Flashcards = {
  cards: { front: string; back: string; startMs: number }[]
}

export type Quiz = {
  questions: {
    question: string
    options: string[]
    answer: number
    explanation: string
    startMs: number
  }[]
}

export type Thread = {
  id: string
  videoId: string | null
  title: string
  createdAt: string
  updatedAt: string
}

export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: string
  voice?: boolean
  /** An answer's progress; questions are always "done". */
  status: AnswerStatus
  /** Why an answer failed (a code the app explains). */
  error?: AnswerError
  /** The video a question was asked about ("/" picker); on a library
   * answer, the video its [m:ss] times point into. */
  video?: VideoRef
}

export type AnswerStatus = "streaming" | "done" | "failed" | "stopped"

export type AnswerError =
  | "quota"
  | "ai_unavailable"
  | "timeout"
  | "restarted"
  | "failed"

export type VideoRef = {
  id: string
  title: string
  thumbnailUrl: string | null
}

export type Picture = {
  id: string
  concept: string
  caption?: string
  locale: "en" | "si"
  status: "pending" | "ready" | "failed"
  error?: string
  createdAt: string
  url?: string
}
