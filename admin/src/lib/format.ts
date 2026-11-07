const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
]

/** "3 minutes ago", "yesterday", or "just now". */
export function timeAgo(value: string | null | undefined): string {
  if (!value) return "Never"
  const seconds = (new Date(value).getTime() - Date.now()) / 1000
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size)
      return relative.format(Math.round(seconds / size), unit)
  }
  return "just now"
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—"
  return dateTime.format(new Date(value))
}

export function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function initials(name: string, email: string): string {
  const source = name.trim() || email
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?"
}

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
})

export function formatNumber(value: number): string {
  return integer.format(value)
}

/** "640 ms", "1.2 s", "5m 44s", "1h 02m". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${oneDecimal.format(seconds)} s`
  const totalSeconds = Math.round(seconds)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  return `${m}m ${String(s).padStart(2, "0")}s`
}

/** Video position or length as "4:05" or "1:02:09". */
export function formatClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—"
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

/** "40.1 h" of video. */
export function formatHours(ms: number): string {
  return `${oneDecimal.format(ms / 3_600_000)} h`
}

export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`
}

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
})
const timeOfDay = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
})

export function formatShortDate(value: string | Date): string {
  return shortDate.format(typeof value === "string" ? new Date(value) : value)
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—"
  return timeOfDay.format(new Date(value))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${oneDecimal.format(value)} ${units[unit]}`
}

/**
 * Every local calendar day from `from` to `to`, inclusive, at midnight.
 * Steps by date rather than by 24 hours, so daylight-saving changes never
 * repeat or skip a day.
 */
export function eachDay(from: Date, to: Date): Date[] {
  const day = new Date(from)
  day.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(0, 0, 0, 0)
  const days: Date[] = []
  while (day <= end) {
    days.push(new Date(day))
    day.setDate(day.getDate() + 1)
  }
  return days
}
