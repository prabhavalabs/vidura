export type Role = "superuser" | "member"
export type UserStatus = "active" | "disabled"

export type User = {
  id: string
  email: string
  name: string
  imageUrl: string
  role: Role
  status: UserStatus
  /** Configured in VIDURA_SUPERUSER_EMAILS; can't be changed from the portal. */
  owner: boolean
  createdAt: string
  lastSeenAt: string | null
}

export type AdminUser = User & { activeSessions: number }

export type Invite = {
  email: string
  createdAt: string
  invitedBy: { id: string; email: string; name: string } | null
  accepted: boolean
}

export type AuditEntry = {
  id: string
  at: string
  actorId: string
  actorEmail: string
  action: string
  target: string
  detail: Record<string, unknown> | null
  ip: string
}

export type AuditPage = { entries: AuditEntry[]; nextCursor: string | null }

export type Overview = {
  accounts: {
    users: number
    active: number
    disabled: number
    superusers: number
    pendingInvites: number
    activeSessions: number
  }
  server: {
    version: string
    env: string
    startedAt: string
    uptimeSec: number
  }
}

// --- catalog ----------------------------------------------------------------

export type VideoStatus =
  | "queued"
  | "fetching_transcript"
  | "transcribing"
  | "translating"
  | "ready"
  | "failed"

export type TranscriptSource = "captions" | "asr" | "uploaded"

export type JobStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled"

export type JobSummary = {
  id: string
  kind: "process_video" | "retranslate" | "retranscribe"
  status: JobStatus
  step: string | null
  progress: number
  durationMs: number | null
  startedAt: string | null
  finishedAt: string | null
}

export type Video = {
  id: string
  youtubeId: string
  youtubeUrl: string
  title: string
  channelTitle: string | null
  thumbnailUrl: string | null
  durationMs: number | null
  sourceLanguage: string | null
  targetLanguage: string
  status: VideoStatus
  errorMessage: string | null
  transcriptSource: TranscriptSource | null
  transcriptEngine: string | null
  qualityScore: number | null
  qualityLabel: string | null
  translationModel: string | null
  owner: { id: string; email: string; name: string }
  segments: number
  translated: number
  jobs: number
  lastJob: JobSummary | null
  createdAt: string
  updatedAt: string
}

export type SubtitleQuality = {
  label?: string
  score?: number
  source?: string
  metrics?: Record<string, number>
}

export type TranslationContext = {
  topic?: string
  summary?: string
  audience?: string
  translationGuidelines?: string
  keyTerms?: Array<{ source: string; preferredSinhala: string }>
}

export type Segment = {
  index: number
  startMs: number
  endMs: number
  text: string
  translation: string | null
  model: string | null
  edited: boolean
}

export type Job = JobSummary & {
  attempts: number
  errorMessage: string | null
  details: Record<string, unknown>
  legacy: boolean
  createdAt: string
  requestedBy: string | null
  video?: {
    id: string
    title: string
    thumbnailUrl: string | null
    durationMs: number | null
    transcriptSource: TranscriptSource | null
  }
}

export type VideoDetail = {
  video: Video & {
    subtitleQuality?: SubtitleQuality
    translationContext?: TranslationContext
  }
  segments: Segment[]
  jobs: Job[]
}

export type NamedCount = { name: string; count: number }

export type Stats = {
  totals: {
    videos: number
    ready: number
    failed: number
    inProgress: number
    users: number
    segments: number
    translatedSegments: number
    videoMs: number
    chatMessages: number
  }
  processing: {
    runs: number
    succeeded: number
    failed: number
    successRate: number
    medianMs: number
    p90Ms: number
    averageMs: number
    speedRatio: number
  }
  sources: Array<{
    source: string
    engine: string
    videos: number
    medianRunMs: number
  }>
  models: NamedCount[]
  failures: NamedCount[]
  statuses: NamedCount[]
  timeline: Array<{
    createdAt: string
    status: JobStatus
    durationMs: number | null
    source: string
  }>
  videos: Array<{
    id: string
    title: string
    durationMs: number
    runMs: number
    source: string
  }>
}

export type SystemStatus = {
  server: { version: string; env: string; startedAt: string; uptimeSec: number }
  database: { sizeBytes: number }
  agentsOnline: number
  urls: { api: string; admin: string; client: string }
}

export type AIModel = {
  slug: string
  name: string
  description: string
  defaultEffort: string
  efforts: string[]
}

export type AITask = "summary" | "translate" | "chat"
export type TaskConfig = { model: string; effort: string }

export type EngineInstall = {
  state: "queued" | "installing" | "ready" | "failed"
  detail: string
  updatedAt: string
}

export type AIStatus = {
  state: "not_installed" | "not_connected" | "connecting" | "connected"
  cli: { installed: boolean; version: string }
  account: { email: string; plan: string } | null
  login: {
    url: string
    code: string
    expiresAt: string
    startedBy: string
  } | null
  lastError?: string
  checkedAt: string
}

export type AITestResult = { reply: string; durationMs: number }

export type DeviceEngine = {
  id: string
  name: string
  ready: boolean
  detail: string
}

export type Device = {
  id: string
  name: string
  hostname: string
  platform: string
  agentVersion: string
  capabilities: {
    agentVersion: string
    hostname: string
    os: string
    arch: string
    engines: DeviceEngine[]
    tools: Record<string, boolean>
  } | null
  pairedBy: string | null
  createdAt: string
  lastSeenAt: string | null
  lastIp: string
  online: boolean
  connectedAt: string | null
  installs: Record<string, EngineInstall>
}

export type PairingCode = {
  pairing: { code: string; expiresAt: string }
  serverUrl: string
}

export type Engine = "parakeet" | "phonon" | "whisper"

export type AppSettings = {
  asrFallback: boolean
  asrEngine: Engine
  ai: Record<AITask, TaskConfig>
}

export type AuditListPage = { entries: AuditEntry[]; total: number }
