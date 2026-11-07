import * as React from "react"
import {
  AlertCircleIcon,
  ImageIcon,
  PaletteIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { useDeletePicture, useMakePicture, usePictures } from "@/lib/queries"

export function PicturesView({
  videoId,
  locale,
}: {
  videoId: string
  locale: string
}) {
  const t = useT()
  const pictures = usePictures(videoId)
  const make = useMakePicture(videoId)
  const remove = useDeletePicture(videoId)
  const [concept, setConcept] = React.useState("")
  const drawing = pictures.data?.some((p) => p.status === "pending")

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t.learn.intro.pictures}</p>
      <form
        className="flex flex-col gap-2 @sm/learn:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          make.mutate(
            { concept, locale },
            {
              onSuccess: () => setConcept(""),
              onError: (error) => toast.error(errorMessage(error)),
            }
          )
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <PaletteIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={concept}
            onChange={(event) => setConcept(event.target.value)}
            placeholder={t.learn.conceptPlaceholder}
            maxLength={300}
            aria-label={t.learn.conceptPlaceholder}
          />
        </InputGroup>
        <Button type="submit" disabled={make.isPending || drawing}>
          {make.isPending ? <Spinner /> : <ImageIcon />}
          {t.learn.draw}
        </Button>
      </form>

      {pictures.isPending ? (
        <Skeleton className="aspect-[16/9] w-full rounded-xl" />
      ) : (pictures.data ?? []).length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ImageIcon />
            </EmptyMedia>
            <EmptyDescription>{t.learn.noPictures}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="grid gap-4">
          {pictures.data?.map((picture) => (
            <li key={picture.id}>
              <Card className="gap-0 overflow-hidden py-0">
                {picture.status === "ready" && picture.url ? (
                  <img
                    src={picture.url}
                    alt={picture.caption ?? picture.concept}
                    loading="lazy"
                    className="aspect-[16/9] w-full bg-white object-contain"
                  />
                ) : picture.status === "pending" ? (
                  <div className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-3 bg-muted p-6 text-center text-sm text-muted-foreground">
                    <Spinner className="size-6" />
                    {t.learn.drawing}
                  </div>
                ) : (
                  <div className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-2 bg-destructive/5 p-6 text-center text-sm text-destructive">
                    <AlertCircleIcon className="size-6" />
                    {picture.error ?? t.common.somethingWrong}
                  </div>
                )}
                <CardContent className="flex items-start justify-between gap-3 p-3">
                  <div
                    className="flex min-w-0 flex-col gap-0.5"
                    lang={picture.locale}
                  >
                    <p className="font-medium">{picture.concept}</p>
                    {picture.caption && (
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {picture.caption}
                      </p>
                    )}
                  </div>
                  {picture.status !== "pending" && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove.mutate(picture.id)}
                      aria-label={t.learn.deletePicture}
                    >
                      <Trash2Icon />
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
