import * as React from "react"
import { SearchIcon, VideoIcon, XIcon } from "lucide-react"
import { useSearchParams } from "react-router"

import { AddVideoForm } from "@/components/add-video-form"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { VideoCard } from "@/components/video-card"
import { errorMessage } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { useIsMobile } from "@/hooks/use-mobile"
import { useLibrary, useLibraryFeed } from "@/lib/queries"
import type { LibraryFilter } from "@/lib/types"

const PAGE_SIZE = 24
const filters: LibraryFilter[] = ["all", "ready", "processing", "failed"]

/** Pages to offer: the first, the last, and two either side of this one. */
function pageNumbers(page: number, pages: number): (number | "gap")[] {
  const out: (number | "gap")[] = []
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 1) out.push(n)
    else if (out[out.length - 1] !== "gap") out.push("gap")
  }
  return out
}

export function LibraryPage() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const q = params.get("q") ?? ""
  const filter = (
    filters.includes(params.get("filter") as LibraryFilter)
      ? params.get("filter")
      : "all"
  ) as LibraryFilter
  const page = Math.max(1, Number(params.get("page")) || 1)
  // Phones get one growing list (infinite scroll); wider screens get
  // numbered pages. Both read the same server-side pages.
  const mobile = useIsMobile()
  const paged = useLibrary({ q, filter, page, size: PAGE_SIZE }, !mobile)
  const feed = useLibraryFeed({ q, filter, size: PAGE_SIZE }, mobile)
  const library = mobile ? feed : paged

  // The search box updates the address a moment after typing stops.
  const [search, setSearch] = React.useState(q)
  // Follow the address when it changes elsewhere (back button, a link).
  const [seenQ, setSeenQ] = React.useState(q)
  if (q !== seenQ) {
    setSeenQ(q)
    setSearch(q)
  }
  React.useEffect(() => {
    if (search.trim() === q) return
    const timer = window.setTimeout(() => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (search.trim()) next.set("q", search.trim())
          else next.delete("q")
          next.delete("page")
          return next
        },
        { replace: true }
      )
    }, 300)
    return () => window.clearTimeout(timer)
  }, [search, q, setParams])

  function update(change: Record<string, string | null>) {
    setParams((current) => {
      const next = new URLSearchParams(current)
      for (const [key, value] of Object.entries(change)) {
        if (value === null) next.delete(key)
        else next.set(key, value)
      }
      return next
    })
  }

  function goTo(n: number) {
    update({ page: n > 1 ? String(n) : null })
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const data = mobile ? feed.data?.pages[0] : paged.data
  const videos = React.useMemo(() => {
    if (!mobile) return paged.data?.videos ?? []
    // A video added meanwhile shifts the pages; drop any repeat.
    const seen = new Set<string>()
    return (feed.data?.pages ?? [])
      .flatMap((p) => p.videos)
      .filter((v) => !seen.has(v.id) && Boolean(seen.add(v.id)))
  }, [mobile, paged.data, feed.data])
  const counts = data?.counts
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1
  const searching = Boolean(q)
  const libraryEmpty = counts?.all === 0 && !searching
  const labels: Record<LibraryFilter, string> = {
    all: t.library.all,
    ready: t.library.ready,
    processing: t.library.processing,
    failed: t.library.failed,
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {t.library.title}
          </h1>
          <p className="text-sm text-muted-foreground">{t.library.subtitle}</p>
        </div>
        <div className="w-full lg:max-w-xl">
          <AddVideoForm />
        </div>
      </section>

      {!libraryEmpty && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:border-b sm:pb-4">
          {/* Scrolls sideways on a narrow phone rather than the page. */}
          <ScrollArea className="w-full sm:w-auto">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={filter}
              onValueChange={(value) =>
                value &&
                update({ filter: value === "all" ? null : value, page: null })
              }
            >
              {filters
                .filter(
                  (f) => f === "all" || f === "ready" || (counts?.[f] ?? 0) > 0
                )
                .map((f) => (
                  <ToggleGroupItem key={f} value={f} className="shrink-0">
                    {labels[f]}
                    {counts && (
                      <span className="text-muted-foreground tabular-nums">
                        {counts[f]}
                      </span>
                    )}
                  </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <ScrollBar orientation="horizontal" className="h-1.5" />
          </ScrollArea>
          <InputGroup className="sm:max-w-72">
            <InputGroupAddon>
              {library.isFetching && search.trim() !== "" ? (
                <Spinner />
              ) : (
                <SearchIcon />
              )}
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              placeholder={t.library.search}
              aria-label={t.library.search}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              enterKeyHint="search"
            />
            {search && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  onClick={() => setSearch("")}
                  aria-label={t.common.cancel}
                >
                  <XIcon />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
      )}

      {library.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex flex-col gap-3">
              <Skeleton className="aspect-video w-full rounded-xl" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      ) : library.isError ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t.library.loadFailed}</EmptyTitle>
            <EmptyDescription>{errorMessage(library.error)}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={() => library.refetch()}>
            {t.common.tryAgain}
          </Button>
        </Empty>
      ) : libraryEmpty ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <VideoIcon />
            </EmptyMedia>
            <EmptyTitle>{t.library.emptyTitle}</EmptyTitle>
            <EmptyDescription>{t.library.emptyBody}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : data && videos.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t.library.noMatchTitle}</EmptyTitle>
            <EmptyDescription>{t.library.noMatchBody}</EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            onClick={() => {
              setSearch("")
              setParams({})
            }}
          >
            {t.library.showAll}
          </Button>
        </Empty>
      ) : (
        data && (
          <>
            <div
              className="grid gap-4 transition-opacity data-[stale=true]:opacity-60 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              data-stale={library.isPlaceholderData}
            >
              {videos.map((video) => (
                <VideoCard key={video.id} video={video} />
              ))}
            </div>
            {mobile ? (
              <FeedEnd
                hasMore={Boolean(feed.hasNextPage)}
                loading={feed.isFetchingNextPage}
                onMore={() => void feed.fetchNextPage()}
                total={data.total}
              />
            ) : (
              pages > 1 && (
                <div className="flex flex-col items-center gap-2">
                  <Pagination>
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          href="#"
                          text={t.library.previous}
                          aria-disabled={page <= 1}
                          className={
                            page <= 1 ? "pointer-events-none opacity-50" : ""
                          }
                          onClick={(event) => {
                            event.preventDefault()
                            if (page > 1) goTo(page - 1)
                          }}
                        />
                      </PaginationItem>
                      {pageNumbers(page, pages).map((n, i) =>
                        n === "gap" ? (
                          <PaginationItem
                            key={`gap-${i}`}
                            className="hidden sm:block"
                          >
                            <span className="px-2 text-muted-foreground">
                              …
                            </span>
                          </PaginationItem>
                        ) : (
                          <PaginationItem key={n} className="hidden sm:block">
                            <PaginationLink
                              href="#"
                              isActive={n === page}
                              onClick={(event) => {
                                event.preventDefault()
                                goTo(n)
                              }}
                            >
                              {n}
                            </PaginationLink>
                          </PaginationItem>
                        )
                      )}
                      <PaginationItem>
                        <PaginationNext
                          href="#"
                          text={t.library.next}
                          aria-disabled={page >= pages}
                          className={
                            page >= pages
                              ? "pointer-events-none opacity-50"
                              : ""
                          }
                          onClick={(event) => {
                            event.preventDefault()
                            if (page < pages) goTo(page + 1)
                          }}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                  <p className="text-sm text-muted-foreground">
                    {t.library.pageOf(page, pages)} ·{" "}
                    {t.library.count(data.total)}
                  </p>
                </div>
              )
            )}
          </>
        )
      )}
    </div>
  )
}

/**
 * The bottom of the phone list: loads the next page as it scrolls into view
 * (well before the reader reaches it), and says when everything is shown.
 */
function FeedEnd({
  hasMore,
  loading,
  onMore,
  total,
}: {
  hasMore: boolean
  loading: boolean
  onMore: () => void
  total: number
}) {
  const t = useT()
  const ref = React.useRef<HTMLDivElement>(null)
  const more = React.useRef(onMore)
  React.useEffect(() => {
    more.current = onMore
  })
  React.useEffect(() => {
    const node = ref.current
    if (!node || !hasMore || loading) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more.current()
      },
      { rootMargin: "800px 0px" }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading])

  return (
    <div
      ref={ref}
      className="flex min-h-12 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      {hasMore ? (
        loading ? (
          <>
            <Spinner />
            {t.library.loadingMore}
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={onMore}>
            {t.library.loadingMore}
          </Button>
        )
      ) : (
        total > 0 && t.library.allLoaded(total)
      )}
    </div>
  )
}
