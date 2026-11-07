import * as React from "react"
import {
  ActivityIcon,
  FilmIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  Settings2Icon,
  UsersIcon,
} from "lucide-react"
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
import { useOverview, useStats } from "@/lib/queries"
import type { User } from "@/lib/types"

export function AppSidebar({
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & { user: User }) {
  const overview = useOverview()
  const stats = useStats()
  const pendingInvites = overview.data?.accounts.pendingInvites ?? 0
  const failedVideos = stats.data?.totals.failed ?? 0

  const libraryItems: NavItem[] = [
    { title: "Overview", url: "/", icon: <LayoutDashboardIcon />, end: true },
    {
      title: "Videos",
      url: "/videos",
      icon: <FilmIcon />,
      badge: stats.data ? stats.data.totals.videos : undefined,
    },
    {
      title: "Processing",
      url: "/processing",
      icon: <ActivityIcon />,
      badge:
        failedVideos > 0 ? (
          <span className="text-failure">{failedVideos}</span>
        ) : undefined,
    },
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
  const systemItems: NavItem[] = [
    { title: "Settings", url: "/settings", icon: <Settings2Icon /> },
  ]

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-b from-success to-success/70 shadow-sm">
                  <img src="/vidura-icon.svg" alt="" className="size-8" />
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
        <NavMain label="Library" items={libraryItems} />
        <NavMain label="Access" items={accessItems} />
        <NavMain label="System" items={systemItems} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
