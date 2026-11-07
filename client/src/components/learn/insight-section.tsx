import * as React from "react"
import { AlertCircleIcon, RotateCcwIcon, SparklesIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { useInsight, useMakeInsight } from "@/lib/queries"
import type { InsightKind } from "@/lib/types"

/**
 * One kind of study notes: offers to make it, shows progress while it's
 * being made, and hands the content to `children` once it's ready.
 */
export function InsightSection<T>({
  videoId,
  kind,
  locale,
  children,
}: {
  videoId: string
  kind: InsightKind
  locale: string
  children: (content: T, remake: React.ReactNode) => React.ReactNode
}) {
  const t = useT()
  const insight = useInsight<T>(videoId, kind, locale)
  const make = useMakeInsight(videoId, kind, locale)
  const start = () =>
    make.mutate(undefined, {
      onError: (error) => toast.error(errorMessage(error)),
    })

  if (insight.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }
  const data = insight.data
  if (!data || data.status === "none") {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SparklesIcon />
          </EmptyMedia>
          <EmptyDescription>{t.learn.intro[kind]}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={start} disabled={make.isPending}>
            {make.isPending ? <Spinner /> : <SparklesIcon />}
            {t.learn.make[kind]}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  if (data.status === "pending") {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyDescription>{t.learn.making}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const remake = (
    <Button
      variant="ghost"
      size="sm"
      onClick={start}
      disabled={make.isPending}
      className="text-muted-foreground"
    >
      <RotateCcwIcon />
      {t.learn.remake}
    </Button>
  )
  if (data.status === "failed" || !data.content) {
    return (
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>{t.learn.failed}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>{data.error ?? t.common.somethingWrong}</span>
          <Button size="sm" variant="outline" onClick={start}>
            <RotateCcwIcon />
            {t.common.tryAgain}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  return <>{children(data.content, remake)}</>
}
