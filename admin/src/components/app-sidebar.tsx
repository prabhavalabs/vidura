import * as React from "react"
import { LayoutDashboardIcon, ScrollTextIcon, UsersIcon } from "lucide-react"
import { Link } from "react-router"

import { NavMain, type NavItem } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { useOverview } from "@/lib/queries"
import type { User } from "@/lib/types"

export function AppSidebar({
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & { user: User }) {
  const overview = useOverview()
  const pendingInvites = overview.data?.accounts.pendingInvites ?? 0

  const overviewItems: NavItem[] = [
    { title: "Dashboard", url: "/", icon: <LayoutDashboardIcon />, end: true },
  ]
  const accessItems: NavItem[] = [
    {
      title: "Users",
      url: "/users",
      icon: <UsersIcon />,
      badge: pendingInvites > 0 ? pendingInvites : undefined,
    },
    { title: "Audit log", url: "/audit", icon: <ScrollTextIcon /> },
  ]

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center overflow-hidden rounded-lg">
                  <img src="/admin/vidura-icon.svg" alt="" className="size-8" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Vidura</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Admin portal
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain label="Overview" items={overviewItems} />
        <NavMain label="Access" items={accessItems} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
