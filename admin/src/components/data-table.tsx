// The shadcn data-table pattern (TanStack Table + shadcn Table), with every
// piece of table state in the URL: search (q), page, sort and each faceted
// filter. Links to a filtered page can be shared and the Back button works.
// Pages are numbered and hold 15 rows; scrolling goes through ScrollArea.
import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  type PaginationState,
  type SortingState,
  type Updater,
  type VisibilityState,
} from "@tanstack/react-table"
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CheckIcon,
  PlusCircleIcon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react"
import { useSearchParams } from "react-router"
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
  CommandSeparator,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const PAGE_SIZE = 15

/** Keeps rows whose value is one of the selected filter values. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const facetFilter: FilterFn<any> = (row, id, value: string[]) =>
  value.length === 0 || value.includes(String(row.getValue(id)))

export type FacetOption = {
  label: string
  value: string
  icon?: React.ComponentType<{ className?: string }>
}

export type Facet = {
  /** Column id; also the URL parameter name. */
  column: string
  title: string
  options: FacetOption[]
}

// --- URL state ------------------------------------------------------------

/**
 * Reads and writes a table's state in the URL. `prefix` keeps two tables on
 * one page apart (for example "u." and "i.").
 */
export function useTableUrl(prefix = "") {
  const [params, setParams] = useSearchParams()
  const get = React.useCallback(
    (key: string) => params.get(prefix + key),
    [params, prefix]
  )
  const update = React.useCallback(
    (changes: Record<string, string | null>, push = false) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          for (const [key, value] of Object.entries(changes)) {
            if (value === null || value === "") next.delete(prefix + key)
            else next.set(prefix + key, value)
          }
          return next
        },
        { replace: !push }
      ),
    [setParams, prefix]
  )
  const href = React.useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(params)
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(prefix + key)
        else next.set(prefix + key, value)
      }
      const query = next.toString()
      return query ? `?${query}` : "?"
    },
    [params, prefix]
  )
  const page = Math.max(1, Number.parseInt(get("page") ?? "1", 10) || 1)
  const query = get("q") ?? ""
  const values = React.useCallback(
    (column: string) => (get(column) ?? "").split(",").filter(Boolean),
    [get]
  )
  return { get, update, href, page, query, values }
}

// --- header ---------------------------------------------------------------

export function SortableHeader<TData>({
  column,
  title,
  align = "start",
}: {
  column: Column<TData, unknown>
  title: string
  align?: "start" | "end"
}) {
  const sorted = column.getIsSorted()
  return (
    <div className={cn("flex", align === "end" && "justify-end")}>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          "h-7 px-2 text-xs font-normal text-muted-foreground",
          align === "end" ? "-mr-2" : "-ml-2"
        )}
        onClick={() => column.toggleSorting(sorted === "asc")}
      >
        {title}
        {sorted === "asc" ? (
          <ArrowUpIcon />
        ) : sorted === "desc" ? (
          <ArrowDownIcon />
        ) : (
          <ArrowUpDownIcon className="opacity-50" />
        )}
      </Button>
    </div>
  )
}

// --- faceted filter (shadcn "tasks" example) --------------------------------

export function FacetedFilter({
  title,
  options,
  selected,
  counts,
  onChange,
}: {
  title: string
  options: FacetOption[]
  selected: string[]
  counts?: Map<unknown, number>
  onChange: (values: string[]) => void
}) {
  const chosen = new Set(selected)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 border-dashed">
          <PlusCircleIcon />
          {title}
          {chosen.size > 0 && (
            <>
              <Separator
                orientation="vertical"
                className="mx-0.5 data-[orientation=vertical]:h-4"
              />
              <Badge
                variant="secondary"
                className="rounded-sm px-1 font-normal lg:hidden"
              >
                {chosen.size}
              </Badge>
              <div className="hidden gap-1 lg:flex">
                {chosen.size > 2 ? (
                  <Badge
                    variant="secondary"
                    className="rounded-sm px-1 font-normal"
                  >
                    {chosen.size} selected
                  </Badge>
                ) : (
                  options
                    .filter((option) => chosen.has(option.value))
                    .map((option) => (
                      <Badge
                        key={option.value}
                        variant="secondary"
                        className="rounded-sm px-1 font-normal"
                      >
                        {option.label}
                      </Badge>
                    ))
                )}
              </div>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = chosen.has(option.value)
                const count = counts?.get(option.value)
                return (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.value}`}
                    onSelect={() => {
                      const next = new Set(chosen)
                      if (isSelected) next.delete(option.value)
                      else next.add(option.value)
                      onChange([...next])
                    }}
                  >
                    <span
                      className={cn(
                        "flex size-4 items-center justify-center rounded-[4px] border",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input [&_svg]:invisible"
                      )}
                    >
                      <CheckIcon className="size-3.5 text-current" />
                    </span>
                    {option.icon && (
                      <option.icon className="size-4 text-muted-foreground" />
                    )}
                    <span className="truncate">{option.label}</span>
                    {count !== undefined && (
                      <span className="tabular ml-auto font-mono text-xs text-muted-foreground">
                        {count}
                      </span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
            {chosen.size > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => onChange([])}
                    className="justify-center text-center"
                  >
                    Clear filter
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// --- numbered pagination --------------------------------------------------

/** Page numbers with ellipses: 1 … 4 5 6 … 12. */
function pageWindow(current: number, total: number): Array<number | "gap"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages = new Set([1, total, current - 1, current, current + 1])
  if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p))
  if (current >= total - 2)
    [total - 1, total - 2, total - 3].forEach((p) => pages.add(p))
  const sorted = [...pages]
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b)
  const out: Array<number | "gap"> = []
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) out.push("gap")
    out.push(page)
  })
  return out
}

export function NumberedPagination({
  page,
  pageCount,
  href,
  onPage,
}: {
  page: number
  pageCount: number
  href: (page: number) => string
  onPage: (page: number) => void
}) {
  if (pageCount <= 1) return null
  const go = (target: number) => (event: React.MouseEvent) => {
    event.preventDefault()
    if (target >= 1 && target <= pageCount && target !== page) onPage(target)
  }
  return (
    <Pagination className="mx-0 w-auto">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={href(Math.max(1, page - 1))}
            onClick={go(page - 1)}
            aria-disabled={page <= 1}
            className={cn("h-8", page <= 1 && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
        {pageWindow(page, pageCount).map((entry, index) =>
          entry === "gap" ? (
            <PaginationItem key={`gap-${index}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={entry}>
              <PaginationLink
                href={href(entry)}
                onClick={go(entry)}
                isActive={entry === page}
                className="tabular size-8 font-mono text-xs"
              >
                {entry}
              </PaginationLink>
            </PaginationItem>
          )
        )}
        <PaginationItem>
          <PaginationNext
            href={href(Math.min(pageCount, page + 1))}
            onClick={go(page + 1)}
            aria-disabled={page >= pageCount}
            className={cn(
              "h-8",
              page >= pageCount && "pointer-events-none opacity-50"
            )}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}

// --- the table ------------------------------------------------------------

function resolve<T>(updater: Updater<T>, previous: T): T {
  return typeof updater === "function"
    ? (updater as (old: T) => T)(previous)
    : updater
}

export function DataTable<TData>({
  columns,
  data,
  loading,
  searchPlaceholder = "Search…",
  empty,
  toolbar,
  facets = [],
  onRowClick,
  activeRowId,
  getRowId,
  footer,
  initialSort,
  urlPrefix = "",
  manual,
  noSearch,
  initialHidden = [],
}: {
  columns: ColumnDef<TData>[]
  data: TData[]
  loading?: boolean
  searchPlaceholder?: string
  empty: React.ReactNode
  /** Extra controls on the right of the toolbar. */
  toolbar?: React.ReactNode
  facets?: Facet[]
  /** Makes rows clickable (and reachable with Enter). */
  onRowClick?: (row: TData) => void
  /** Highlights the row whose id matches (the one open in a dialog). */
  activeRowId?: string | null
  getRowId?: (row: TData) => string
  /** Shown under the table, left of the pager. */
  footer?: React.ReactNode
  initialSort?: { id: string; desc: boolean }
  /** Prefix for URL parameters when a page has several tables. */
  urlPrefix?: string
  /** Server-side paging: the rows are one page and rowCount is the total. */
  manual?: { rowCount: number }
  noSearch?: boolean
  /** Columns hidden until turned on under View. */
  initialHidden?: string[]
}) {
  const url = useTableUrl(urlPrefix)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const [visibility, setVisibility] = React.useState<VisibilityState>(() =>
    Object.fromEntries(initialHidden.map((id) => [id, false]))
  )
  const [search, setSearch] = React.useState(url.query)
  const [syncedQuery, setSyncedQuery] = React.useState(url.query)

  // The URL is the source of truth; typing updates it after a short pause,
  // and Back/Forward (a new query in the URL) resets the box.
  if (url.query !== syncedQuery) {
    setSyncedQuery(url.query)
    setSearch(url.query)
  }
  const { update } = url
  React.useEffect(() => {
    if (search === syncedQuery) return
    const id = window.setTimeout(() => update({ q: search, page: null }), 200)
    return () => window.clearTimeout(id)
  }, [search, syncedQuery, update])

  const sortParam = url.get("sort")
  const sorting: SortingState = React.useMemo(() => {
    if (sortParam) {
      const [id, direction] = sortParam.split(".")
      return [{ id, desc: direction !== "asc" }]
    }
    return initialSort ? [initialSort] : []
  }, [sortParam, initialSort])

  const facetKey = facets.map((facet) => url.get(facet.column) ?? "").join("|")
  const columnFilters: ColumnFiltersState = React.useMemo(
    () =>
      facets
        .map((facet) => ({
          id: facet.column,
          value: (url.get(facet.column) ?? "").split(",").filter(Boolean),
        }))
        .filter((filter) => filter.value.length > 0),
    // facetKey captures every facet value in the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facetKey]
  )
  const pagination: PaginationState = {
    pageIndex: url.page - 1,
    pageSize: PAGE_SIZE,
  }

  // TanStack Table returns functions that can't be memoized; the React
  // Compiler lint rule knows to skip this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: {
      sorting,
      globalFilter: url.query,
      columnFilters,
      pagination,
      columnVisibility: visibility,
    },
    onSortingChange: (updater) => {
      const next = resolve(updater, sorting)[0]
      update({
        sort: next ? `${next.id}.${next.desc ? "desc" : "asc"}` : null,
        page: null,
      })
    },
    onPaginationChange: (updater) => {
      const next = resolve(updater, pagination)
      update(
        { page: next.pageIndex > 0 ? String(next.pageIndex + 1) : null },
        true
      )
    },
    onColumnVisibilityChange: setVisibility,
    manualPagination: Boolean(manual),
    manualFiltering: Boolean(manual),
    rowCount: manual?.rowCount,
    autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getPaginationRowModel: getPaginationRowModel(),
  })

  // "/" jumps to the search box, as in most dashboards.
  React.useEffect(() => {
    if (noSearch) return
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        target?.closest(
          "input, textarea, [contenteditable=true], [role=dialog]"
        )
      )
        return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [noSearch])

  const rows = table.getRowModel().rows
  const total = manual
    ? manual.rowCount
    : table.getFilteredRowModel().rows.length
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(url.page, pageCount)
  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const lastRow = Math.min(total, page * PAGE_SIZE)
  const filtered = Boolean(url.query) || columnFilters.length > 0

  // A page past the end (after filtering) snaps back to the last page.
  React.useEffect(() => {
    if (!loading && url.page > pageCount)
      update({ page: pageCount > 1 ? String(pageCount) : null })
  }, [loading, url.page, pageCount, update])

  const hideable = table
    .getAllColumns()
    .filter((column) => column.getCanHide() && column.id !== "actions")

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {!noSearch && (
          <InputGroup className="h-8 w-full sm:w-64">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              placeholder={searchPlaceholder}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={searchPlaceholder}
            />
            <InputGroupAddon align="inline-end" className="hidden sm:flex">
              <Kbd>/</Kbd>
            </InputGroupAddon>
          </InputGroup>
        )}
        {facets.map((facet) => (
          <FacetedFilter
            key={facet.column}
            title={facet.title}
            options={facet.options}
            selected={url.values(facet.column)}
            counts={
              manual
                ? undefined
                : table.getColumn(facet.column)?.getFacetedUniqueValues()
            }
            onChange={(values) =>
              update({ [facet.column]: values.join(","), page: null })
            }
          />
        ))}
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setSearch("")
              update({
                q: null,
                page: null,
                ...Object.fromEntries(
                  facets.map((facet) => [facet.column, null])
                ),
              })
            }}
          >
            Reset
            <XIcon />
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {toolbar}
          {hideable.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="hidden h-8 lg:flex"
                >
                  <Settings2Icon />
                  View
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {hideable.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) =>
                      column.toggleVisibility(Boolean(value))
                    }
                    onSelect={(event) => event.preventDefault()}
                  >
                    {(column.columnDef.meta as { label?: string } | undefined)
                      ?.label ?? column.id}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <ScrollArea className="w-full">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className="h-9 text-xs font-normal text-muted-foreground first:pl-3 last:pr-3"
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <TableRow key={`loading-${index}`}>
                    {table.getVisibleLeafColumns().map((column) => (
                      <TableCell
                        key={column.id}
                        className="py-3 first:pl-3 last:pr-3"
                      >
                        <Skeleton className="h-5 w-full max-w-40" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : rows.length > 0 ? (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={
                      activeRowId && row.id === activeRowId
                        ? "selected"
                        : undefined
                    }
                    className={
                      onRowClick
                        ? "cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
                        : undefined
                    }
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={
                      onRowClick
                        ? (event) => {
                            // Links, buttons and menus inside the row work alone.
                            if (
                              (event.target as HTMLElement).closest(
                                "a, button, [role=menuitem], [role=menu]"
                              )
                            )
                              return
                            onRowClick(row.original)
                          }
                        : undefined
                    }
                    onKeyDown={
                      onRowClick
                        ? (event) => {
                            if (
                              event.key === "Enter" &&
                              event.target === event.currentTarget
                            )
                              onRowClick(row.original)
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className="py-2 first:pl-3 last:pr-3"
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={table.getVisibleLeafColumns().length}
                    className="p-0"
                  >
                    {filtered ? (
                      <p className="py-10 text-center text-sm text-muted-foreground">
                        Nothing matches these filters.
                      </p>
                    ) : (
                      empty
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="tabular">
            {total === 0 ? "No rows" : `${firstRow}–${lastRow} of ${total}`}
          </span>
          {footer}
        </div>
        <NumberedPagination
          page={page}
          pageCount={pageCount}
          href={(target) =>
            url.href({ page: target > 1 ? String(target) : null })
          }
          onPage={(target) =>
            update({ page: target > 1 ? String(target) : null }, true)
          }
        />
      </div>
    </div>
  )
}
