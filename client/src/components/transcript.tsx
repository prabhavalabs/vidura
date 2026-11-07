import * as React from "react"
import { LocateFixedIcon } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { clock } from "@/lib/format"
import { useT } from "@/lib/i18n"
import type { Segment } from "@/lib/types"

type View = "si" | "both" | "en"

/**
 * Every line of the video. The current one is highlighted and kept in view
 * until the reader scrolls the list themselves; then it stays put and a
 * button brings it back to the current line.
 */
export const Transcript = React.memo(function Transcript({
  segments,
  active,
  onSeek,
}: {
  segments: Segment[]
  active: number
  onSeek: (ms: number) => void
}) {
  const t = useT()
  const [view, setView] = React.useState<View>("si")
  const [following, setFollowing] = React.useState(true)
  const root = React.useRef<HTMLDivElement>(null)
  // The first scroll after mounting jumps; later ones glide.
  const placed = React.useRef(false)

  React.useEffect(() => {
    if (!following || active < 0) return
    const box = root.current?.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]"
    )
    const row = box?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!box || !row) return
    // Keep the current line a third of the way down, so the next few
    // lines are readable below it.
    const offset =
      row.getBoundingClientRect().top - box.getBoundingClientRect().top
    const top = box.scrollTop + offset - box.clientHeight / 3
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    box.scrollTo({
      top: Math.max(0, top),
      behavior: placed.current && !still ? "smooth" : "auto",
    })
    placed.current = true
  }, [active, following, view])

  // Only the reader's own scrolling stops the following, not ours.
  const letGo = React.useCallback(() => setFollowing(false), [])
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(
        event.key
      )
    )
      letGo()
  }

  const seek = React.useCallback(
    (ms: number) => {
      setFollowing(true)
      onSeek(ms)
    },
    [onSeek]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view}
          onValueChange={(value) => value && setView(value as View)}
          aria-label={t.transcript.title}
        >
          <ToggleGroupItem value="si" lang="si">
            {t.transcript.sinhala}
          </ToggleGroupItem>
          <ToggleGroupItem value="both">{t.transcript.both}</ToggleGroupItem>
          <ToggleGroupItem value="en">{t.transcript.english}</ToggleGroupItem>
        </ToggleGroup>
        <span className="text-xs text-muted-foreground tabular-nums">
          {active >= 0 ? `${active + 1} / ${segments.length}` : segments.length}
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea
          ref={root}
          onWheel={letGo}
          onTouchMove={letGo}
          onKeyDown={onKeyDown}
          // Dragging the scrollbar thumb.
          onPointerDown={(event) => {
            if (
              (event.target as HTMLElement).closest(
                "[data-slot=scroll-area-scrollbar]"
              )
            )
              letGo()
          }}
          className="min-h-0 flex-1 rounded-xl border bg-card/40 [&_[data-slot=scroll-area-viewport]]:overscroll-contain"
        >
          <ol className="flex flex-col gap-0.5 p-1.5">
            {segments.map((segment, i) => (
              <Line
                key={segment.index}
                index={i}
                segment={segment}
                view={view}
                current={i === active}
                onSeek={seek}
                notTranslated={t.transcript.notTranslated}
              />
            ))}
          </ol>
        </ScrollArea>
        {!following && active >= 0 && (
          <Button
            size="sm"
            onClick={() => setFollowing(true)}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-lg duration-200 animate-in fade-in-0 slide-in-from-bottom-1"
          >
            <LocateFixedIcon />
            {t.transcript.follow}
          </Button>
        )}
      </div>
    </div>
  )
})

/** One line; memoised so a new current line re-renders two rows, not all. */
const Line = React.memo(function Line({
  index,
  segment,
  view,
  current,
  onSeek,
  notTranslated,
}: {
  index: number
  segment: Segment
  view: View
  current: boolean
  onSeek: (ms: number) => void
  notTranslated: string
}) {
  return (
    <li data-index={index}>
      <button
        type="button"
        onClick={() => onSeek(segment.startMs)}
        className={cn(
          "group/line relative flex w-full gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 outline-none hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50",
          current && "bg-muted hover:bg-muted"
        )}
        aria-current={current || undefined}
      >
        <span
          className={cn(
            "mt-0.5 w-11 shrink-0 text-xs text-muted-foreground tabular-nums transition-colors",
            current && "font-medium text-foreground"
          )}
        >
          {clock(segment.startMs)}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          {view !== "en" &&
            (segment.translation ? (
              <span
                lang="si"
                className={cn(
                  "font-sinhala leading-relaxed text-foreground/85",
                  current && "text-foreground"
                )}
              >
                {segment.translation}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground italic">
                {notTranslated}
              </span>
            ))}
          {view !== "si" && (
            <span
              className={cn(
                view === "both"
                  ? "text-sm leading-snug text-muted-foreground"
                  : "leading-relaxed text-foreground/85",
                view === "en" && current && "text-foreground"
              )}
            >
              {segment.text}
            </span>
          )}
        </span>
      </button>
    </li>
  )
})
