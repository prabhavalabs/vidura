import {
  ArrowRightIcon,
  KeyRoundIcon,
  MailPlusIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react"
import { Link } from "react-router"

import { Page } from "@/components/site-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { describeAction } from "@/lib/audit-actions"
import { formatDuration, timeAgo } from "@/lib/format"
import { useAuditLog, useOverview } from "@/lib/queries"

function StatCard({
  label,
  value,
  icon,
  footer,
  loading,
}: {
  label: string
  value: number | undefined
  icon: React.ReactNode
  footer: string
  loading: boolean
}) {
  return (
    <Card className="@container/card bg-gradient-to-t from-primary/5 to-card shadow-xs dark:bg-card">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {loading ? <Skeleton className="h-8 w-16" /> : value}
        </CardTitle>
        <CardAction>
          <Badge
            variant="outline"
            className="text-muted-foreground [&>svg]:size-3.5"
          >
            {icon}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardFooter className="text-sm text-muted-foreground">
        {footer}
      </CardFooter>
    </Card>
  )
}

export function DashboardPage() {
  const overview = useOverview()
  const audit = useAuditLog("")
  const accounts = overview.data?.accounts
  const server = overview.data?.server
  const recent = audit.data?.pages[0]?.entries.slice(0, 8) ?? []

  return (
    <Page
      crumbs={[{ label: "Dashboard" }]}
      title="Dashboard"
      description="Who can use Vidura, and what’s happening on the server."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Users"
          value={accounts?.users}
          icon={<UsersIcon />}
          loading={overview.isPending}
          footer={
            accounts
              ? `${accounts.active} active · ${accounts.disabled} disabled`
              : "Loading…"
          }
        />
        <StatCard
          label="Superusers"
          value={accounts?.superusers}
          icon={<ShieldCheckIcon />}
          loading={overview.isPending}
          footer="Can use this admin portal"
        />
        <StatCard
          label="Pending invites"
          value={accounts?.pendingInvites}
          icon={<MailPlusIcon />}
          loading={overview.isPending}
          footer="Invited, not signed in yet"
        />
        <StatCard
          label="Active sessions"
          value={accounts?.activeSessions}
          icon={<KeyRoundIcon />}
          loading={overview.isPending}
          footer="Signed-in browsers and devices"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Sign-ins and account changes</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/audit">
                  View all
                  <ArrowRightIcon />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {audit.isPending ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-5 w-full" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {recent.map((entry) => {
                  const action = describeAction(entry.action)
                  return (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between gap-4 py-2.5 text-sm first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Badge variant={action.variant}>{action.label}</Badge>
                        <span className="truncate text-muted-foreground">
                          {entry.actorEmail || "Unknown"}
                          {entry.target && entry.target !== entry.actorEmail
                            ? ` → ${entry.target}`
                            : ""}
                        </span>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {timeAgo(entry.at)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Server</CardTitle>
            <CardDescription>This Vidura instance</CardDescription>
          </CardHeader>
          <CardContent>
            {server ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Version</dt>
                <dd className="truncate font-mono text-xs leading-5">
                  {server.version}
                </dd>
                <dt className="text-muted-foreground">Environment</dt>
                <dd>
                  <Badge
                    variant={
                      server.env === "production" ? "default" : "secondary"
                    }
                  >
                    {server.env}
                  </Badge>
                </dd>
                <dt className="text-muted-foreground">Uptime</dt>
                <dd>{formatDuration(server.uptimeSec)}</dd>
              </dl>
            ) : (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-2/3" />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}
