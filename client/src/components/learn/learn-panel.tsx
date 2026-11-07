import * as React from "react"
import {
  BookOpenTextIcon,
  ImageIcon,
  LayersIcon,
  ListChecksIcon,
} from "lucide-react"

import { FlashcardsView } from "@/components/learn/flashcards-view"
import { PicturesView } from "@/components/learn/pictures-view"
import { QuizView } from "@/components/learn/quiz-view"
import { SummaryView } from "@/components/learn/summary-view"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLocale } from "@/lib/i18n"

/** Study notes, flashcards, a quiz and pictures for one video. */
export function LearnPanel({
  videoId,
  onSeek,
}: {
  videoId: string
  onSeek: (ms: number) => void
}) {
  const { t, locale: uiLocale } = useLocale()
  const [locale, setLocale] = React.useState<string>(uiLocale)
  const [tool, setTool] = React.useState("summary")

  const tools = [
    { value: "summary", label: t.learn.summary, icon: BookOpenTextIcon },
    { value: "flashcards", label: t.learn.flashcards, icon: LayersIcon },
    { value: "quiz", label: t.learn.quiz, icon: ListChecksIcon },
    { value: "pictures", label: t.learn.pictures, icon: ImageIcon },
  ]

  return (
    <Tabs
      value={tool}
      onValueChange={setTool}
      // Labels show once the panel is wide enough for them; a narrow side
      // panel or a phone gets icons with the label read out instead.
      className="@container/learn flex min-h-0 flex-1 flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <TabsList className="min-w-0 flex-1">
          {tools.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              aria-label={item.label}
              title={item.label}
            >
              <item.icon />
              <span className="hidden truncate @md/learn:inline">
                {item.label}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={locale}
          onValueChange={(value) => value && setLocale(value)}
          aria-label={t.learn.language}
          className="shrink-0"
        >
          <ToggleGroupItem value="si" lang="si">
            සිං
          </ToggleGroupItem>
          <ToggleGroupItem value="en">EN</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
        <div className="pt-1 pb-4">
          <TabsContent value="summary">
            <SummaryView videoId={videoId} locale={locale} onSeek={onSeek} />
          </TabsContent>
          <TabsContent value="flashcards">
            <FlashcardsView videoId={videoId} locale={locale} onSeek={onSeek} />
          </TabsContent>
          <TabsContent value="quiz">
            <QuizView videoId={videoId} locale={locale} onSeek={onSeek} />
          </TabsContent>
          <TabsContent value="pictures">
            <PicturesView videoId={videoId} locale={locale} />
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  )
}
