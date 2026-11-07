import { PlayIcon } from "lucide-react"

import { InsightSection } from "@/components/learn/insight-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { clock } from "@/lib/format"
import { useT } from "@/lib/i18n"
import type { Summary } from "@/lib/types"

export function SummaryView({
  videoId,
  locale,
  onSeek,
}: {
  videoId: string
  locale: string
  onSeek: (ms: number) => void
}) {
  const t = useT()
  return (
    <InsightSection<Summary> videoId={videoId} kind="summary" locale={locale}>
      {(summary, remake) => (
        <article lang={locale} className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-heading text-lg leading-snug font-semibold">
              {summary.title}
            </h3>
            {remake}
          </div>
          <section className="flex flex-col gap-1.5">
            <h4 className="text-sm font-medium text-muted-foreground">
              {t.learn.overview}
            </h4>
            <p className="leading-relaxed">{summary.overview}</p>
          </section>

          <ol className="flex flex-col gap-3">
            {summary.sections.map((section, i) => (
              <li key={i}>
                <Card className="gap-2 py-4">
                  <CardHeader className="flex items-start justify-between gap-2 px-4">
                    <CardTitle className="leading-snug">
                      {section.heading}
                    </CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 tabular-nums"
                      onClick={() => onSeek(section.startMs)}
                      aria-label={t.learn.watchFrom(clock(section.startMs))}
                    >
                      <PlayIcon />
                      {clock(section.startMs)}
                    </Button>
                  </CardHeader>
                  <CardContent className="px-4">
                    <ul className="flex list-disc flex-col gap-1 pl-5 leading-relaxed">
                      {section.points.map((point, j) => (
                        <li key={j}>{point}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>

          {summary.takeaways.length > 0 && (
            <section className="flex flex-col gap-2">
              <h4 className="font-medium">{t.learn.takeaways}</h4>
              <ul className="flex flex-col gap-2">
                {summary.takeaways.map((takeaway, i) => (
                  <li key={i} className="flex gap-2 leading-relaxed">
                    <Badge variant="secondary" className="mt-0.5 shrink-0">
                      {i + 1}
                    </Badge>
                    {takeaway}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {summary.terms.length > 0 && (
            <section className="flex flex-col gap-2">
              <Separator />
              <h4 className="font-medium">{t.learn.terms}</h4>
              <dl className="grid gap-3 @lg/learn:grid-cols-2">
                {summary.terms.map((term, i) => (
                  <div key={i} className="rounded-lg border p-3">
                    <dt className="font-medium">{term.term}</dt>
                    <dd className="text-sm leading-relaxed text-muted-foreground">
                      {term.meaning}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </article>
      )}
    </InsightSection>
  )
}
