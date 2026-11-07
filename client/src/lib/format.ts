/** 83_000 → "1:23", 3_723_000 → "1:02:03". */
export function clock(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "–"
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, "0")
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`
}

const formats = new Map<string, Intl.RelativeTimeFormat>()

/** "3 days ago", "yesterday", "just now" (or the Sinhala). */
export function ago(iso: string, locale = "en"): string {
  let relative = formats.get(locale)
  if (!relative) {
    relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
    formats.set(locale, relative)
  }
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
    [Infinity, "year"],
  ]
  let value = seconds
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) {
      return relative.format(
        unit === "second" && Math.abs(value) < 45 ? 0 : Math.round(value),
        unit
      )
    }
    value /= size
  }
  return ""
}

/** Initials for an avatar: "Nipun Theekshana" → "NT". */
export function initials(name: string, email: string): string {
  const words = (name || email).trim().split(/\s+/).filter(Boolean)
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("")
}
