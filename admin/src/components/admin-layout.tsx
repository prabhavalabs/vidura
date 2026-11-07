import { LogOutIcon, ShieldAlertIcon } from "lucide-react"
import { Navigate, Outlet, useLocation } from "react-router"

import { AppSidebar } from "@/components/app-sidebar"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { ApiError } from "@/lib/api"
import { useMe, useSignOut } from "@/lib/queries"

/** Signed-in superusers get the portal; everyone else is sent to sign in. */
export function AdminLayout() {
  const me = useMe()
  const location = useLocation()
  const signOut = useSignOut()

  if (me.isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }

  if (me.error instanceof ApiError && me.error.status === 401) {
    const next = `${location.pathname}${location.search}`
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }

  if (me.isError || !me.data) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldAlertIcon />
            </EmptyMedia>
            <EmptyTitle>Can’t reach the server</EmptyTitle>
            <EmptyDescription>
              {me.error?.message ?? "Try again in a moment."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => me.refetch()}>Try again</Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  if (me.data.role !== "superuser") {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldAlertIcon />
            </EmptyMedia>
            <EmptyTitle>Superusers only</EmptyTitle>
            <EmptyDescription>
              You’re signed in as {me.data.email}, which is a family member
              account. Ask the owner to make you a superuser if you need the
              admin portal.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex gap-2">
              <Button variant="outline" asChild>
                <a href="/">Open Vidura</a>
              </Button>
              <Button variant="ghost" onClick={() => signOut.mutate()}>
                <LogOutIcon />
                Sign out
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <SidebarProvider>
      <AppSidebar user={me.data} />
      <SidebarInset className="min-w-0">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}
