import type { ColumnDef } from "@tanstack/react-table"
import { ScrollTextIcon } from "lucide-react"

import { DataTable, useTableUrl } from "@/components/data-table"
import { Page } from "@/components/site-header"
import { Badge } from "@/components/ui/badge"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { errorMessage } from "@/lib/api"
import { auditActionOptions, describeAction } from "@/lib/audit-actions"
import { formatDateTime, timeAgo } from "@/lib/format"
import { useAuditPage } from "@/lib/queries"
import type { AuditEntry } from "@/lib/types"

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
      <span
        className="block max-w-md truncate text-xs text-muted-foreground"
        title={(getValue() as string) || undefined}
      >
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
  const url = useTableUrl()
  const actions = url.values("action")
  const log = useAuditPage(url.page, actions)

  return (
    <Page
      crumbs={[{ label: "Access" }, { label: "Audit log" }]}
      title="Audit log"
      description="Every sign-in, account change, connection and pipeline action, newest first. Entries can’t be edited."
    >
      {log.isError ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Couldn’t load the audit log</EmptyTitle>
            <EmptyDescription>{errorMessage(log.error)}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <DataTable
          columns={columns}
          data={log.data?.entries ?? []}
          loading={log.isPending}
          manual={{ rowCount: log.data?.total ?? 0 }}
          noSearch
          getRowId={(entry) => entry.id}
          facets={[
            { column: "action", title: "Action", options: auditActionOptions },
          ]}
          empty={
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ScrollTextIcon />
                </EmptyMedia>
                <EmptyTitle>No entries</EmptyTitle>
                <EmptyDescription>
                  Nothing has been recorded yet.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
        />
      )}
    </Page>
  )
}
