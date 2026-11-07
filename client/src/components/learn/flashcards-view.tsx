import * as React from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlayIcon,
  ShuffleIcon,
} from "lucide-react"
import { cn } from "cn"

import { InsightSection } from "@/components/learn/insight-section"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { clock } from "@/lib/format"
import { useT } from "@/lib/i18n"
import type { Flashcards } from "@/lib/types"

export function FlashcardsView({
  videoId,
  locale,
  onSeek,
}: {
  videoId: string
  locale: string
  onSeek: (ms: number) => void
}) {
  return (
    <InsightSection<Flashcards>
      videoId={videoId}
      kind="flashcards"
      locale={locale}
    >
      {(deck, remake) => (
        <Deck
          cards={deck.cards}
          locale={locale}
          onSeek={onSeek}
          remake={remake}
        />
      )}
    </InsightSection>
  )
}

function Deck({
  cards,
  locale,
  onSeek,
  remake,
}: {
  cards: Flashcards["cards"]
  locale: string
  onSeek: (ms: number) => void
  remake: React.ReactNode
}) {
  const t = useT()
  const [order, setOrder] = React.useState(() => cards.map((_, i) => i))
  const [at, setAt] = React.useState(0)
  const [flipped, setFlipped] = React.useState(false)
  const card = cards[order[at]] ?? cards[0]

  function go(next: number) {
    setFlipped(false)
    setAt((next + order.length) % order.length)
  }

  function shuffle() {
    const shuffled = [...order]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    setOrder(shuffled)
    setAt(0)
    setFlipped(false)
  }

  if (!card) return null
  return (
    <div className="flex flex-col gap-4" lang={locale}>
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {t.learn.card(at + 1, order.length)}
        </span>
        {remake}
      </div>
      <Progress value={((at + 1) / order.length) * 100} />
      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        className="group outline-none perspective-[1200px]"
        aria-label={flipped ? t.learn.flipBack : t.learn.flip}
      >
        <div
          className={cn(
            "relative grid min-h-56 transition-transform duration-500 transform-3d motion-reduce:transition-none",
            flipped && "rotate-y-180"
          )}
        >
          <div className="col-start-1 row-start-1 flex flex-col items-center justify-center gap-3 rounded-2xl border bg-card p-6 text-center shadow-sm backface-hidden group-focus-visible:ring-3 group-focus-visible:ring-ring/50">
            <p className="text-lg leading-relaxed font-medium">{card.front}</p>
            <span className="text-xs text-muted-foreground">
              {t.learn.flip}
            </span>
          </div>
          <div className="col-start-1 row-start-1 flex rotate-y-180 flex-col items-center justify-center gap-3 rounded-2xl border bg-primary p-6 text-center text-primary-foreground shadow-sm backface-hidden">
            <p className="leading-relaxed">{card.back}</p>
            <span className="text-xs opacity-75">{t.learn.flipBack}</span>
          </div>
        </div>
      </button>
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="icon"
          onClick={() => go(at - 1)}
          aria-label={t.learn.previous}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={shuffle}>
            <ShuffleIcon />
            {t.learn.shuffle}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="tabular-nums"
            onClick={() => onSeek(card.startMs)}
            aria-label={t.learn.watchFrom(clock(card.startMs))}
          >
            <PlayIcon />
            {clock(card.startMs)}
          </Button>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => go(at + 1)}
          aria-label={t.learn.next}
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  )
}
