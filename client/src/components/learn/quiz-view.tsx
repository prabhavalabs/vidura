import * as React from "react"
import {
  CheckCircle2Icon,
  PlayIcon,
  RotateCcwIcon,
  TrophyIcon,
  XCircleIcon,
} from "lucide-react"
import { cn } from "cn"

import { InsightSection } from "@/components/learn/insight-section"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { clock } from "@/lib/format"
import { useT } from "@/lib/i18n"
import type { Quiz } from "@/lib/types"

export function QuizView({
  videoId,
  locale,
  onSeek,
}: {
  videoId: string
  locale: string
  onSeek: (ms: number) => void
}) {
  return (
    <InsightSection<Quiz> videoId={videoId} kind="quiz" locale={locale}>
      {(quiz, remake) => (
        <Play
          questions={quiz.questions.filter((q) => q.options.length >= 2)}
          locale={locale}
          onSeek={onSeek}
          remake={remake}
        />
      )}
    </InsightSection>
  )
}

function Play({
  questions,
  locale,
  onSeek,
  remake,
}: {
  questions: Quiz["questions"]
  locale: string
  onSeek: (ms: number) => void
  remake: React.ReactNode
}) {
  const t = useT()
  const [at, setAt] = React.useState(0)
  const [choice, setChoice] = React.useState<string>("")
  const [checked, setChecked] = React.useState(false)
  const [right, setRight] = React.useState(0)
  const [done, setDone] = React.useState(false)

  function restart() {
    setAt(0)
    setChoice("")
    setChecked(false)
    setRight(0)
    setDone(false)
  }

  if (done) {
    const great = right / questions.length >= 0.8
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TrophyIcon />
          </EmptyMedia>
          <EmptyTitle>{t.learn.score(right, questions.length)}</EmptyTitle>
          <EmptyDescription>
            {great ? t.learn.scoreGreat : t.learn.scoreGood}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={restart}>
            <RotateCcwIcon />
            {t.learn.retry}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  const q = questions[at]
  if (!q) return null
  const answer = Math.min(Math.max(q.answer, 0), q.options.length - 1)
  const correct = checked && Number(choice) === answer
  const last = at === questions.length - 1

  return (
    <div className="flex flex-col gap-4" lang={locale}>
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {t.learn.question(at + 1, questions.length)}
        </span>
        {remake}
      </div>
      <Progress value={(at / questions.length) * 100} />
      <p className="text-lg leading-relaxed font-medium">{q.question}</p>
      <RadioGroup
        value={choice}
        onValueChange={(value) => !checked && setChoice(value)}
        className="gap-2"
      >
        {q.options.map((option, i) => {
          const state = checked
            ? i === answer
              ? "right"
              : String(i) === choice
                ? "wrong"
                : "idle"
            : "idle"
          return (
            <label
              key={i}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 leading-relaxed transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                !checked && "hover:bg-muted",
                String(i) === choice &&
                  !checked &&
                  "border-primary bg-primary/5",
                state === "right" && "border-success bg-success/10",
                state === "wrong" && "border-destructive bg-destructive/10",
                checked && "cursor-default"
              )}
            >
              <RadioGroupItem
                value={String(i)}
                disabled={checked}
                className="mt-1"
              />
              <span className="flex-1">{option}</span>
              {state === "right" && (
                <CheckCircle2Icon className="mt-0.5 size-5 text-success" />
              )}
              {state === "wrong" && (
                <XCircleIcon className="mt-0.5 size-5 text-destructive" />
              )}
            </label>
          )
        })}
      </RadioGroup>

      {checked && (
        <Alert variant={correct ? "default" : "destructive"}>
          {correct ? <CheckCircle2Icon /> : <XCircleIcon />}
          <AlertTitle>{correct ? t.learn.correct : t.learn.wrong}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span className="text-foreground">{q.explanation}</span>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 tabular-nums"
              onClick={() => onSeek(q.startMs)}
            >
              <PlayIcon />
              {t.learn.watchFrom(clock(q.startMs))}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!checked ? (
        <Button
          disabled={choice === ""}
          onClick={() => {
            setChecked(true)
            if (Number(choice) === answer) setRight((n) => n + 1)
          }}
        >
          {t.learn.check}
        </Button>
      ) : (
        <Button
          onClick={() => {
            if (last) {
              setDone(true)
              return
            }
            setAt(at + 1)
            setChoice("")
            setChecked(false)
          }}
        >
          {last ? t.learn.seeScore : t.learn.nextQuestion}
        </Button>
      )}
    </div>
  )
}
