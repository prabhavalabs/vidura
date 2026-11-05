import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { ScrollTextIcon } from "lucide-react"

import { DataTable } from "@/components/data-table"
import { Page } from "@/components/site-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { errorMessage } from "@/lib/api"
import { auditActionOptions, describeAction } from "@/lib/audit-actions"
import { formatDateTime, timeAgo } from "@/lib/format"
import { useAuditLog } from "@/lib/queries"
import type { AuditEntry } from "@/lib/types"

const ALL = "all"

function formatDetail(detail: AuditEntry["detail"]): string {
  if (!detail) return ""
  return Object.entries(detail)
    .map(([key, value]) => {
      if (
        value &&
        typeof value === "object" &&
        "from" in value &&
        "to" in value
      ) {
        const change = value as { from: unknown; to: unknown }
        return `${key}: ${String(change.from)} → ${String(change.to)}`
      }
      return `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`
    })
    .join(" · ")
}

const columns: ColumnDef<AuditEntry>[] = [
  {
    accessorKey: "at",
    header: "When",
    cell: ({ row }) => (
      <Tooltip>
        <TooltipTrigger className="text-sm whitespace-nowrap text-muted-foreground">
          {timeAgo(row.original.at)}
        </TooltipTrigger>
        <TooltipContent>{formatDateTime(row.original.at)}</TooltipContent>
      </Tooltip>
    ),
  },
  {
    accessorKey: "action",
    header: "Action",
    cell: ({ row }) => {
      const action = describeAction(row.original.action)
      return <Badge variant={action.variant}>{action.label}</Badge>
    },
  },
  {
    accessorKey: "actorEmail",
    header: "By",
    cell: ({ row }) => (
      <span className="text-sm">{row.original.actorEmail || "—"}</span>
    ),
  },
  {
    accessorKey: "target",
    header: "Target",
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.target || "—"}
      </span>
    ),
  },
  {
    id: "detail",
    accessorFn: (entry) => formatDetail(entry.detail),
    header: "Details",
    cell: ({ getValue }) => (
      <span className="text-xs text-muted-foreground">
        {(getValue() as string) || "—"}
      </span>
    ),
  },
  {
    accessorKey: "ip",
    header: "IP",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.ip || "—"}
      </span>
    ),
  },
]

export function AuditPage() {
  const [action, setAction] = React.useState(ALL)
  const log = useAuditLog(action === ALL ? "" : action)
  const entries = React.useMemo(
    () => log.data?.pages.flatMap((page) => page.entries) ?? [],
    [log.data]
  )

  const filter = (
    <Select value={action} onValueChange={setAction}>
      <SelectTrigger className="w-48" aria-label="Filter by action">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ALL}>All actions</SelectItem>
          {auditActionOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )

  return (
    <Page
      crumbs={[{ label: "Access" }, { label: "Audit log" }]}
      title="Audit log"
      description="Every sign-in, refused sign-in and account change, newest first. Entries can’t be edited."
    >
      {log.isError ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Couldn’t load the audit log</EmptyTitle>
            <EmptyDescription>{errorMessage(log.error)}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <DataTable
            columns={columns}
            data={entries}
            loading={log.isPending}
            pageSize={1000}
            searchPlaceholder="Search loaded entries…"
            toolbar={filter}
            empty={
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ScrollTextIcon />
                  </EmptyMedia>
                  <EmptyTitle>No entries</EmptyTitle>
                  <EmptyDescription>
                    Nothing has been recorded for this filter yet.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            }
          />
          {log.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => log.fetchNextPage()}
                disabled={log.isFetchingNextPage}
              >
                {log.isFetchingNextPage && <Spinner />}
                Load older entries
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  )
}
