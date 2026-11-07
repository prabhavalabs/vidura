import * as React from "react"
import { Link } from "react-router"
import { CartesianGrid, Scatter, ScatterChart, XAxis, YAxis } from "recharts"

import { JobStatusBadge, sourceLabel } from "@/components/badges"
import { Page } from "@/components/site-header"
import { Button } from "@/components/ui/button"
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  DotColumns,
  HeatGrid,
  LegendDot,
  Meter,
  Panel,
  StatStrip,
  TickGauge,
  type DotColumn,
  type HeatCell,
} from "@/components/viz"
import {
  eachDay,
  formatHours,
  formatMs,
  formatNumber,
  formatPercent,
  formatShortDate,
  timeAgo,
} from "@/lib/format"
import { useJobs, useStats } from "@/lib/queries"
import type { Stats } from "@/lib/types"

type Range = "30" | "90" | "all"

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Runs inside the range, and the list of days it covers (local time). */
function useRange(stats: Stats | undefined, range: Range) {
  return React.useMemo(() => {
    const timeline = stats?.timeline ?? []
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    let first: Date
    if (range === "all" && timeline.length > 0) {
      first = new Date(timeline[0].createdAt)
      first.setHours(0, 0, 0, 0)
    } else {
      first = new Date(today)
      first.setDate(
        today.getDate() - (Number(range === "all" ? 90 : range) - 1)
      )
    }
    const days = eachDay(first, today)
    const runs = timeline.filter((r) => new Date(r.createdAt) >= first)
    return { days, runs }
  }, [stats, range])
}

export function DashboardPage() {
  const stats = useStats()
  const recent = useJobs("")
  const [range, setRange] = React.useState<Range>("90")
  const { days, runs } = useRange(stats.data, range)

  const rangeLabel = range === "all" ? "All time" : `Last ${range} days`

  const actions = (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={range}
      onValueChange={(value) => value && setRange(value as Range)}
    >
      <ToggleGroupItem value="30" className="px-3">
        30d
      </ToggleGroupItem>
      <ToggleGroupItem value="90" className="px-3">
        90d
      </ToggleGroupItem>
      <ToggleGroupItem value="all" className="px-3">
        All
      </ToggleGroupItem>
    </ToggleGroup>
  )

  if (stats.isPending) {
    return (
      <Page crumbs={[{ label: "Overview" }]} title="Overview" actions={actions}>
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </Page>
    )
  }

  if (stats.isError || !stats.data) {
    return (
      <Page crumbs={[{ label: "Overview" }]} title="Overview">
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Couldn’t load the statistics</EmptyTitle>
            <EmptyDescription>Check that the API is running.</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={() => stats.refetch()}>
            Try again
          </Button>
        </Empty>
      </Page>
    )
  }

  const { totals, processing } = stats.data
  const translatedShare =
    totals.segments > 0 ? totals.translatedSegments / totals.segments : 0

  return (
    <Page crumbs={[{ label: "Overview" }]} title="Overview" actions={actions}>
      <StatStrip
        stats={[
          {
            label: "Videos",
            value: formatNumber(totals.videos),
            hint: `${totals.ready} ready · ${totals.failed} failed`,
          },
          {
            label: "Video watched",
            value: formatHours(totals.videoMs),
            hint: `${formatNumber(totals.segments)} English lines`,
          },
          {
            label: "Lines translated",
            value: formatPercent(translatedShare),
            hint: `${formatNumber(totals.translatedSegments)} of ${formatNumber(totals.segments)}`,
          },
          {
            label: "Median processing",
            value: formatMs(processing.medianMs),
            hint: `p90 ${formatMs(processing.p90Ms)} · ${processing.speedRatio.toFixed(1)}× real time`,
          },
        ]}
      />

      <ActivityPanel days={days} runs={runs} rangeLabel={rangeLabel} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <SuccessPanel stats={stats.data} runs={runs} rangeLabel={rangeLabel} />
        <HourPanel runs={runs} rangeLabel={rangeLabel} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SpeedPanel stats={stats.data} />
        <SourcesPanel stats={stats.data} />
      </div>

      <Panel
        title="Recent runs"
        note="Newest first"
        action={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/processing">View all</Link>
          </Button>
        }
        contentClassName="px-2"
      >
        {recent.isPending ? (
          <div className="flex flex-col gap-2 px-4 pb-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : (
          <ItemGroup className="gap-1 has-data-[size=sm]:gap-1">
            {(recent.data ?? []).slice(0, 6).map((job, index) => (
              <React.Fragment key={job.id}>
                {index > 0 && <ItemSeparator className="my-0" />}
                <Item asChild size="sm" className="rounded-lg">
                  <Link to={`/videos?video=${job.video?.id}`}>
                    <ItemMedia variant="image" className="hidden sm:flex">
                      {job.video?.thumbnailUrl ? (
                        <img
                          src={job.video.thumbnailUrl}
                          alt=""
                          className="aspect-video object-cover"
                        />
                      ) : null}
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="line-clamp-1">
                        {job.video?.title}
                      </ItemTitle>
                      <ItemDescription className="font-mono text-xs">
                        {job.kind === "process_video"
                          ? "Full run"
                          : "Retranslate"}{" "}
                        · {timeAgo(job.createdAt)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="gap-4">
                      <span className="tabular hidden font-mono text-sm text-muted-foreground sm:inline">
                        {formatMs(job.durationMs)}
                      </span>
                      <JobStatusBadge status={job.status} />
                    </ItemActions>
                  </Link>
                </Item>
              </React.Fragment>
            ))}
          </ItemGroup>
        )}
      </Panel>
    </Page>
  )
}

// --- activity -------------------------------------------------------------

function ActivityPanel({
  days,
  runs,
  rangeLabel,
}: {
  days: Date[]
  runs: Stats["timeline"]
  rangeLabel: string
}) {
  const columns: DotColumn[] = React.useMemo(() => {
    const byDay = new Map<string, { ok: number; failed: number }>()
    for (const run of runs) {
      const key = dayKey(new Date(run.createdAt))
      const entry = byDay.get(key) ?? { ok: 0, failed: 0 }
      if (run.status === "failed") entry.failed++
      else if (run.status === "succeeded") entry.ok++
      byDay.set(key, entry)
    }
    return days.map((day) => {
      const entry = byDay.get(dayKey(day)) ?? { ok: 0, failed: 0 }
      return {
        key: dayKey(day),
        label: formatShortDate(day),
        parts: [
          { tone: "success" as const, count: entry.ok },
          { tone: "failure" as const, count: entry.failed },
        ],
      }
    })
  }, [days, runs])

  const max = Math.max(
    1,
    ...columns.map((c) => c.parts.reduce((sum, p) => sum + p.count, 0))
  )
  const rows = 8
  const unit = Math.max(1, Math.ceil(max / rows))
  const ticks = days.length
    ? [0, 0.25, 0.5, 0.75, 1].map((t) =>
        Math.min(days.length - 1, Math.round(t * (days.length - 1)))
      )
    : []
  const failedRuns = runs.filter((r) => r.status === "failed").length

  return (
    <Panel
      title="Processing activity"
      note={`1 dot = ${unit} run${unit === 1 ? "" : "s"}`}
      action={<span className="text-sm text-success">{rangeLabel}</span>}
    >
      <div className="flex flex-col gap-3">
        <DotColumns columns={columns} rows={rows} />
        <div className="relative h-5 text-sm text-muted-foreground">
          {ticks.map((index, i) => (
            <span
              key={`${index}-${i}`}
              className="tabular absolute whitespace-nowrap"
              style={{
                left: `${(index / Math.max(1, days.length - 1)) * 100}%`,
                transform:
                  i === 0
                    ? "none"
                    : i === ticks.length - 1
                      ? "translateX(-100%)"
                      : "translateX(-50%)",
              }}
            >
              {formatShortDate(days[index])}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div className="flex flex-wrap gap-4">
            <LegendDot tone="success" label="Succeeded" />
            <LegendDot tone="failure" label="Failed" />
          </div>
          <span className="tabular text-sm text-muted-foreground">
            {formatNumber(runs.length)} runs · {failedRuns} failed
          </span>
        </div>
      </div>
    </Panel>
  )
}

// --- success --------------------------------------------------------------

function SuccessPanel({
  stats,
  runs,
  rangeLabel,
}: {
  stats: Stats
  runs: Stats["timeline"]
  rangeLabel: string
}) {
  const succeeded = runs.filter((r) => r.status === "succeeded").length
  const failed = runs.filter((r) => r.status === "failed").length
  const finished = succeeded + failed
  const rate = finished > 0 ? succeeded / finished : 1
  const goal = 0.95
  const maxFailures = Math.max(1, ...stats.failures.map((f) => f.count))
  const failureTones = [
    "bg-failure",
    "bg-warning",
    "bg-info",
    "bg-muted-foreground",
  ]

  return (
    <Panel title="Success rate" note={rangeLabel}>
      <div className="flex flex-col gap-4">
        <div>
          <TickGauge value={rate} target={goal}>
            <span className="tabular text-4xl font-normal tracking-tight">
              {finished > 0 ? formatPercent(rate) : "—"}
            </span>
            <span className="tabular mt-1 text-sm text-muted-foreground">
              {failed} of {finished} failed
            </span>
          </TickGauge>
          <div className="mt-1 flex justify-between px-2 text-sm text-muted-foreground">
            <span>0</span>
            <span>Goal {formatPercent(goal, 0)}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <LegendDot tone="success" label="Succeeded" />
            <span className="tabular">{formatNumber(succeeded)}</span>
          </div>
          <div className="flex items-center justify-between">
            <LegendDot tone="failure" label="Failed" />
            <span className="tabular">{formatNumber(failed)}</span>
          </div>
          <div className="flex items-center justify-between">
            <LegendDot tone="muted" label="Videos ready (all time)" />
            <span className="tabular">{formatNumber(stats.totals.ready)}</span>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium">Failures by reason</h3>
            <span className="text-sm text-muted-foreground">All time</span>
          </div>
          {stats.failures.length === 0 ? (
            <p className="text-sm text-muted-foreground">No failures. </p>
          ) : (
            <ItemGroup className="gap-0 rounded-lg border has-data-[size=sm]:gap-0 has-data-[size=xs]:gap-0">
              {stats.failures.map((failure, index) => (
                <React.Fragment key={failure.name}>
                  {index > 0 && <ItemSeparator className="my-0" />}
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>
                        <span
                          className={`h-3.5 w-1 rounded-full ${failureTones[Math.min(index, failureTones.length - 1)]}`}
                        />
                        {failure.name}
                      </ItemTitle>
                    </ItemContent>
                    <ItemActions className="w-24">
                      <Meter
                        value={(failure.count / maxFailures) * 100}
                        tone="failure"
                        className="w-14"
                      />
                      <span className="tabular w-6 text-right">
                        {failure.count}
                      </span>
                    </ItemActions>
                  </Item>
                </React.Fragment>
              ))}
            </ItemGroup>
          )}
        </div>
      </div>
    </Panel>
  )
}

// --- hour heatmap ---------------------------------------------------------

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

function HourPanel({
  runs,
  rangeLabel,
}: {
  runs: Stats["timeline"]
  rangeLabel: string
}) {
  const rows = React.useMemo(() => {
    const grid = weekdays.map((label) => ({
      label,
      cells: Array.from({ length: 24 }, (_, hour): HeatCell => ({
        value: 0,
        failures: 0,
        label: `${label} ${String(hour).padStart(2, "0")}:00`,
      })),
    }))
    for (const run of runs) {
      const date = new Date(run.createdAt)
      const row = (date.getDay() + 6) % 7
      const cell = grid[row].cells[date.getHours()]
      cell.value++
      if (run.status === "failed") cell.failures++
    }
    return grid
  }, [runs])

  const succeeded = runs.filter((r) => r.status === "succeeded").length
  const failed = runs.filter((r) => r.status === "failed").length
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <Panel title="Runs by hour" note={`${rangeLabel} · ${timeZone}`}>
      <div className="flex flex-col gap-4">
        <HeatGrid
          rows={rows}
          columnLabels={[
            { index: 0, label: "00:00" },
            { index: 6, label: "06:00" },
            { index: 12, label: "12:00" },
            { index: 18, label: "18:00" },
            { index: 23, label: "23:00" },
          ]}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            Fewer
            {[18, 36, 54, 72, 100].map((h) => (
              <span
                key={h}
                className="flex h-3.5 w-3.5 items-end rounded-[2px] bg-dot/60"
              >
                <span
                  className="w-full rounded-[2px] bg-success"
                  style={{ height: `${h}%` }}
                />
              </span>
            ))}
            More
          </div>
          <LegendDot tone="failure" label="Hour with a failure" />
        </div>
        <div className="grid grid-cols-3 gap-4 border-t pt-3">
          <BigNumber
            label="Runs"
            value={runs.length}
            tone="bg-muted-foreground"
          />
          <BigNumber label="Succeeded" value={succeeded} tone="bg-success" />
          <BigNumber label="Failed" value={failed} tone="bg-failure" />
        </div>
      </div>
    </Panel>
  )
}

function BigNumber({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="tabular flex items-center gap-2.5 text-2xl tracking-tight">
        <span className={`h-1 w-4 rounded-full ${tone}`} />
        {formatNumber(value)}
      </span>
    </div>
  )
}

// --- speed scatter --------------------------------------------------------

const speedConfig = {
  captions: { label: "YouTube captions", color: "var(--success)" },
  asr: { label: "Speech to text", color: "var(--info)" },
} satisfies ChartConfig

function SpeedPanel({ stats }: { stats: Stats }) {
  const points = stats.videos.map((v) => ({
    x: Math.round((v.durationMs / 60_000) * 10) / 10,
    y: Math.round((v.runMs / 60_000) * 10) / 10,
    title: v.title,
    source: v.source,
  }))
  const captions = points.filter((p) => p.source !== "asr")
  const asr = points.filter((p) => p.source === "asr")

  return (
    <Panel
      title="Video length vs processing time"
      note="Successful runs, minutes"
    >
      <div className="flex flex-col gap-4">
        <ChartContainer
          config={speedConfig}
          className="aspect-auto h-[260px] w-full"
        >
          <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              type="number"
              dataKey="x"
              name="Video length"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => `${v}m`}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="Processing"
              tickLine={false}
              axisLine={false}
              tickMargin={4}
              tickFormatter={(v) => `${v}m`}
            />
            <ChartTooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload as
                  (typeof points)[number] | undefined
                if (!active || !point) return null
                return (
                  <div className="grid max-w-64 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
                    <span className="line-clamp-2 font-medium">
                      {point.title}
                    </span>
                    <span className="tabular text-muted-foreground">
                      {point.x} min video · processed in {point.y} min
                    </span>
                  </div>
                )
              }}
            />
            <Scatter
              name="captions"
              data={captions}
              fill="var(--color-captions)"
            />
            <Scatter name="asr" data={asr} fill="var(--color-asr)" />
          </ScatterChart>
        </ChartContainer>
        <div className="flex flex-wrap gap-4">
          <LegendDot tone="success" label="YouTube captions" />
          <LegendDot tone="info" label="Speech to text" />
        </div>
      </div>
    </Panel>
  )
}

// --- sources and models ---------------------------------------------------

function SourcesPanel({ stats }: { stats: Stats }) {
  const totalVideos = Math.max(
    1,
    stats.sources.reduce((sum, s) => sum + s.videos, 0)
  )
  const totalModels = Math.max(
    1,
    stats.models.reduce((sum, m) => sum + m.count, 0)
  )
  return (
    <Panel title="How videos were processed" note="All time">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <h3 className="text-sm text-muted-foreground">English transcript</h3>
          {stats.sources.map((source) => (
            <div
              key={`${source.source}-${source.engine}`}
              className="flex flex-col gap-2"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span>
                  {sourceLabel(source.source)}
                  {source.engine && (
                    <span className="ml-2 font-mono text-sm text-muted-foreground">
                      {source.engine}
                    </span>
                  )}
                </span>
                <span className="tabular text-sm text-muted-foreground">
                  {source.videos} videos · median {formatMs(source.medianRunMs)}
                </span>
              </div>
              <Meter
                value={(source.videos / totalVideos) * 100}
                tone={source.source === "asr" ? "info" : "success"}
              />
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            Videos without captions will be transcribed on your Mac once it’s
            paired in Settings.
          </p>
        </div>
        <div className="flex flex-col gap-3 border-t pt-3">
          <h3 className="text-sm text-muted-foreground">Translation model</h3>
          {stats.models.map((model) => (
            <div key={model.name} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-sm">{model.name}</span>
                <span className="tabular text-sm text-muted-foreground">
                  {model.count} videos
                </span>
              </div>
              <Meter value={(model.count / totalModels) * 100} tone="muted" />
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            New translations run on your ChatGPT subscription.
          </p>
        </div>
      </div>
    </Panel>
  )
}
