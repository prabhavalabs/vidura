import * as React from "react"
import { ClapperboardIcon, XIcon } from "lucide-react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { useIsMobile } from "@/hooks/use-mobile"
import { clock } from "@/lib/format"
import { useLocale } from "@/lib/i18n"
import { useVideoSearch } from "@/lib/queries"
import type { VideoRef } from "@/lib/types"

/**
 * The composer's "/" picker: the learner's ready videos, searched on the
 * server as they type. It opens above the composer (children) on wider
 * screens, and as a bottom drawer on phones, where a popover over the
 * keyboard has no room.
 */
export function VideoPicker({
  open,
  onClose,
  exclude,
  children,
}: {
  open: boolean
  /** Closed with the video picked, or without one (and what was typed). */
  onClose: (result: { video?: VideoRef; query: string }) => void
  /** A video not to offer (the one the conversation is about). */
  exclude?: string
  children: React.ReactNode
}) {
  const { t } = useLocale()
  const isMobile = useIsMobile()
  const [query, setQuery] = React.useState("")
  const [search, setSearch] = React.useState("")
  // A fresh search each time it opens.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQuery("")
      setSearch("")
    }
  }
  React.useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200)
    return () => clearTimeout(timer)
  }, [query])

  const results = useVideoSearch(search, open)
  const videos = (results.data?.videos ?? []).filter((v) => v.id !== exclude)
  const searching =
    results.isPending || (results.isFetching && search !== query.trim())

  // Results arrive after the list is drawn, so cmdk doesn't highlight the
  // first one by itself: keep a highlighted result, the first by default,
  // so Enter picks it.
  const [selected, setSelected] = React.useState("")
  const ids = videos.map((v) => v.id).join(",")
  const [seenIds, setSeenIds] = React.useState(ids)
  if (ids !== seenIds) {
    setSeenIds(ids)
    if (!videos.some((v) => v.id === selected)) setSelected(videos[0]?.id ?? "")
  }

  const list = (
    <Command
      shouldFilter={false}
      value={selected}
      onValueChange={setSelected}
      className="rounded-none! bg-transparent"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t.chat.pickerSearch}
        aria-label={t.chat.pickerSearch}
        autoFocus
      />
      <CommandList className={cn(isMobile && "max-h-[50svh]")}>
        {searching && videos.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner />
            {t.chat.pickerLoading}
          </div>
        ) : (
          <CommandEmpty>{t.chat.pickerEmpty}</CommandEmpty>
        )}
        {videos.length > 0 && (
          <CommandGroup heading={t.chat.pickerGroup}>
            {videos.map((video) => (
              <CommandItem
                key={video.id}
                value={video.id}
                onSelect={() =>
                  onClose({
                    video: {
                      id: video.id,
                      title: video.title,
                      thumbnailUrl: video.thumbnailUrl,
                    },
                    query,
                  })
                }
                className="gap-3 py-2"
              >
                <Thumbnail url={video.thumbnailUrl} className="h-9 w-16" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="line-clamp-2 text-sm leading-snug">
                    {video.title}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[
                      video.channelTitle,
                      video.durationMs ? clock(video.durationMs) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  )

  if (isMobile) {
    return (
      <>
        {children}
        <Drawer
          open={open}
          onOpenChange={(next) => !next && onClose({ query })}
        >
          <DrawerContent>
            <DrawerHeader className="pb-1">
              <DrawerTitle>{t.chat.pickerTitle}</DrawerTitle>
              <DrawerDescription className="sr-only">
                {t.chat.pickerSearch}
              </DrawerDescription>
            </DrawerHeader>
            <div className="px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {list}
            </div>
          </DrawerContent>
        </Drawer>
      </>
    )
  }
  return (
    <Popover open={open} onOpenChange={(next) => !next && onClose({ query })}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] min-w-72 p-0"
        // The composer takes focus back itself.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {list}
      </PopoverContent>
    </Popover>
  )
}

function Thumbnail({
  url,
  className,
}: {
  url: string | null
  className?: string
}) {
  return url ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      className={cn("shrink-0 rounded-sm bg-muted object-cover", className)}
    />
  ) : (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground",
        className
      )}
    >
      <ClapperboardIcon className="size-4" />
    </span>
  )
}

/** A video named in the composer or on a question. */
export function VideoChip({
  video,
  label,
  onRemove,
  className,
}: {
  video: VideoRef
  label?: string
  onRemove?: () => void
  className?: string
}) {
  const { t } = useLocale()
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-7 max-w-full min-w-0 justify-start gap-1.5 rounded-md pr-0.5 pl-1",
        !onRemove && "pr-2",
        className
      )}
    >
      <Thumbnail url={video.thumbnailUrl} className="h-5 w-9" />
      {label && <span className="shrink-0 text-muted-foreground">{label}</span>}
      <span className="min-w-0 truncate">{video.title}</span>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0"
          onClick={onRemove}
          aria-label={t.chat.removeVideo}
        >
          <XIcon />
        </Button>
      )}
    </Badge>
  )
}
