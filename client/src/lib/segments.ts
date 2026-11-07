import type { Segment } from "@/lib/types"

/** The line being spoken at `ms`, if any (lines are sorted by start). */
export function lineAt(segments: Segment[], ms: number): number {
  let low = 0
  let high = segments.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (segments[mid].startMs <= ms + 200) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}
