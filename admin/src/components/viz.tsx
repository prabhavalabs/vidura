// Small visual building blocks shared by the dashboard, videos and processing
// pages: dot timelines, the tick gauge, the hour heatmap, meters, legends and
// the stat strip. They draw with the theme's tokens (success, failure, dot)
// so they follow light and dark mode.
import * as React from "react"
import { cn } from "cn"

import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export type Tone = "success" | "failure" | "warning" | "info" | "muted"

const toneBg: Record<Tone, string> = {
  success: "bg-success",
  failure: "bg-failure",
  warning: "bg-warning",
  info: "bg-info",
  muted: "bg-muted-foreground/50",
}

const toneText: Record<Tone, string> = {
  success: "text-success",
  failure: "text-failure",
  warning: "text-warning",
  info: "text-info",
  muted: "text-muted-foreground",
}

export function toneClass(tone: Tone, kind: "bg" | "text" = "bg") {
  return kind === "bg" ? toneBg[tone] : toneText[tone]
}

// --- legend ---------------------------------------------------------------

export function LegendDot({
  tone,
  label,
  hollow,
}: {
  tone: Tone
  label: React.ReactNode
  hollow?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          hollow
            ? cn(
                "border border-dashed bg-transparent",
                toneText[tone],
                "border-current"
              )
            : toneBg[tone]
        )}
      />
      {label}
    </span>
  )
}

// --- dot columns ----------------------------------------------------------

export type DotColumn = {
  key: string
  /** Shown in the tooltip. */
  label: React.ReactNode
  /** Stacked from the bottom, in order. */
  parts: Array<{ tone: Tone; count: number }>
}

/**
 * A dot-matrix timeline: one column per bucket, one dot per `unit` items,
 * filled from the bottom. Empty slots stay as faint dots so the grid reads as
 * a whole.
 */
export function DotColumns({
  columns,
  rows = 8,
  className,
  highlight,
}: {
  columns: DotColumn[]
  rows?: number
  className?: string
  /** Column keys drawn with a frame, e.g. the selected range. */
  highlight?: Set<string>
}) {
  const max = Math.max(
    1,
    ...columns.map((c) => c.parts.reduce((sum, p) => sum + p.count, 0))
  )
  const unit = Math.max(1, Math.ceil(max / rows))

  return (
    <div
      className={cn("grid items-end gap-x-[3px]", className)}
      style={{
        gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
      }}
    >
      {columns.map((column) => {
        const dots: Tone[] = []
        for (const part of column.parts) {
          for (let i = 0; i < Math.ceil(part.count / unit); i++)
            dots.push(part.tone)
        }
        const total = column.parts.reduce((sum, p) => sum + p.count, 0)
        return (
          <Tooltip key={column.key}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "flex flex-col-reverse items-center gap-[3px] rounded-md py-1",
                  highlight?.has(column.key) &&
                    "bg-success/10 ring-1 ring-success/40"
                )}
              >
                {Array.from({ length: rows }, (_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "size-[5px] rounded-full sm:size-1.5",
                      dots[i] ? toneBg[dots[i]] : "bg-dot"
                    )}
                  />
                ))}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{column.label}</span>
                {total === 0 ? (
                  <span className="text-background/70">Nothing</span>
                ) : (
                  column.parts
                    .filter((p) => p.count > 0)
                    .map((p) => (
                      <span key={p.tone} className="tabular">
                        {p.count} {toneLabel[p.tone]}
                      </span>
                    ))
                )}
              </div>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

const toneLabel: Record<Tone, string> = {
  success: "succeeded",
  failure: "failed",
  warning: "waiting",
  info: "running",
  muted: "other",
}

// --- tick gauge -----------------------------------------------------------

/**
 * A semicircle of ticks. `value` (0–1) is drawn in the success colour and the
 * rest in the failure colour; `target` adds a dotted marker (e.g. an SLO).
 */
export function TickGauge({
  value,
  target,
  ticks = 56,
  children,
}: {
  value: number
  target?: number
  ticks?: number
  children?: React.ReactNode
}) {
  const size = 300
  const cx = size / 2
  const cy = size / 2 + 10
  const outer = 138
  const inner = 112
  const start = Math.PI * 1.08
  const end = -Math.PI * 0.08
  const filled = Math.round(value * ticks)

  return (
    <div className="relative mx-auto aspect-[300/190] w-full max-w-[280px]">
      <svg viewBox={`0 0 ${size} 190`} className="size-full" aria-hidden>
        {Array.from({ length: ticks }, (_, i) => {
          const t = i / (ticks - 1)
          const angle = start + (end - start) * t
          const x1 = cx + Math.cos(angle) * inner
          const y1 = cy - Math.sin(angle) * inner
          const x2 = cx + Math.cos(angle) * outer
          const y2 = cy - Math.sin(angle) * outer
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              strokeWidth={4.5}
              strokeLinecap="round"
              className={i < filled ? "stroke-success" : "stroke-failure"}
            />
          )
        })}
        {target !== undefined && (
          <line
            x1={cx + Math.cos(start + (end - start) * target) * (inner - 10)}
            y1={cy - Math.sin(start + (end - start) * target) * (inner - 10)}
            x2={cx + Math.cos(start + (end - start) * target) * (outer + 8)}
            y2={cy - Math.sin(start + (end - start) * target) * (outer + 8)}
            strokeWidth={2}
            strokeDasharray="2 3"
            className="stroke-foreground/70"
          />
        )}
      </svg>
      <div className="absolute inset-x-0 top-[38%] flex flex-col items-center text-center">
        {children}
      </div>
    </div>
  )
}

// --- heat grid ------------------------------------------------------------

export type HeatCell = { value: number; failures: number; label: string }

/**
 * Rows of cells whose bar height follows the value, pink where something
 * failed. Like a GitHub contribution grid, but readable at a glance.
 */
export function HeatGrid({
  rows,
  columnLabels,
}: {
  rows: Array<{ label: string; cells: HeatCell[] }>
  columnLabels: Array<{ index: number; label: string }>
}) {
  const max = Math.max(1, ...rows.flatMap((r) => r.cells.map((c) => c.value)))
  const columns = rows[0]?.cells.length ?? 0
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-3">
          <span className="w-8 shrink-0 text-xs text-muted-foreground">
            {row.label}
          </span>
          <div
            className="grid flex-1 gap-[3px]"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
          >
            {row.cells.map((cell, index) => (
              <Tooltip key={index}>
                <TooltipTrigger asChild>
                  <div className="flex h-5 items-end rounded-[3px] bg-dot/60">
                    {cell.value > 0 && (
                      <div
                        className={cn(
                          "w-full rounded-[3px]",
                          cell.failures > 0 ? "bg-failure" : "bg-success"
                        )}
                        style={{
                          height: `${Math.max(14, (cell.value / max) * 100)}%`,
                        }}
                      />
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{cell.label}</span>
                    <span className="tabular">
                      {cell.value} run{cell.value === 1 ? "" : "s"}
                      {cell.failures > 0 && ` · ${cell.failures} failed`}
                    </span>
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <span className="w-9 shrink-0" />
        <div className="relative h-5 flex-1 text-xs text-muted-foreground">
          {columnLabels.map((tick) => (
            <span
              key={tick.index}
              className="tabular absolute -translate-x-1/2"
              style={{ left: `${((tick.index + 0.5) / columns) * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// --- meter ----------------------------------------------------------------

/** A thin bar with a value, like a latency bar. */
export function Meter({
  value,
  tone = "success",
  live,
  className,
}: {
  /** 0–100. */
  value: number
  tone?: Tone
  /** Pulses while the work behind it is still running. */
  live?: boolean
  className?: string
}) {
  return (
    <Progress
      value={Math.max(0, Math.min(100, value))}
      className={cn(
        "h-1.5 bg-dot [&>[data-slot=progress-indicator]]:duration-700",
        live && "[&>[data-slot=progress-indicator]]:animate-pulse",
        tone === "success" && "[&>[data-slot=progress-indicator]]:bg-success",
        tone === "failure" && "[&>[data-slot=progress-indicator]]:bg-failure",
        tone === "warning" && "[&>[data-slot=progress-indicator]]:bg-warning",
        tone === "info" && "[&>[data-slot=progress-indicator]]:bg-info",
        tone === "muted" &&
          "[&>[data-slot=progress-indicator]]:bg-muted-foreground",
        className
      )}
    />
  )
}

// --- stat strip -----------------------------------------------------------

export type Stat = {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
}

/** A row of big numbers in one card, split by hairlines. */
export function StatStrip({
  stats,
  className,
}: {
  stats: Stat[]
  className?: string
}) {
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      {/* Every cell draws a right and bottom hairline; the negative margin
          pushes the outer ones under the card's clipped edge. */}
      <div
        className={cn(
          "-mr-px -mb-px grid grid-cols-2",
          stats.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"
        )}
      >
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="flex flex-col gap-0.5 border-r border-b px-4 py-3"
          >
            <span className="text-xs text-muted-foreground">{stat.label}</span>
            <span className="tabular text-2xl font-normal tracking-tight">
              {stat.value}
            </span>
            {stat.hint && (
              <span className="truncate text-xs text-muted-foreground">
                {stat.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

// --- panel ----------------------------------------------------------------

/** A titled card section with an optional note on the right. */
export function Panel({
  title,
  note,
  action,
  children,
  className,
  contentClassName,
}: {
  title: React.ReactNode
  note?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <Card className={cn("gap-3", className)}>
      <div className="flex min-h-7 items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          {note && (
            <span className="truncate text-xs text-muted-foreground">
              {note}
            </span>
          )}
        </div>
        {action}
      </div>
      <div className={cn("min-h-0 flex-1 px-4", contentClassName)}>
        {children}
      </div>
    </Card>
  )
}
