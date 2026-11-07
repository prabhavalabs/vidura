import { Link } from "react-router"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

export type Crumb = { label: string; to?: string }

/**
 * The bar at the top of every page: the app mark, a "Vidura / Section / Page"
 * trail that doubles as the page title, and the page's controls on the right.
 */
export function SiteHeader({
  crumbs,
  actions,
}: {
  crumbs: Crumb[]
  actions?: React.ReactNode
}) {
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2.5 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:px-5">
      <SidebarTrigger className="-ml-1" />
      <Separator
        orientation="vertical"
        className="data-[orientation=vertical]:h-5"
      />
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap text-sm sm:text-[15px]">
          <BreadcrumbItem className="hidden sm:inline-flex">
            <BreadcrumbLink asChild>
              <Link to="/">Vidura</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1
            return (
              <span key={`${crumb.label}-${index}`} className="contents">
                <BreadcrumbSeparator
                  className={
                    index === 0 ? "hidden sm:block" : "hidden md:block"
                  }
                >
                  /
                </BreadcrumbSeparator>
                <BreadcrumbItem
                  className={last ? "min-w-0" : "hidden md:inline-flex"}
                >
                  {last || !crumb.to ? (
                    <BreadcrumbPage className="truncate font-medium">
                      {crumb.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link to={crumb.to}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </span>
            )
          })}
        </BreadcrumbList>
      </Breadcrumb>
      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  )
}

/** Standard page body: the header, an optional intro line, then content. */
export function Page({
  crumbs,
  actions,
  title,
  description,
  children,
}: {
  crumbs: Crumb[]
  actions?: React.ReactNode
  /** Announced to screen readers; the breadcrumb is the visible title. */
  title: string
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <>
      <SiteHeader crumbs={crumbs} actions={actions} />
      <div className="mx-auto flex w-full max-w-[1440px] min-w-0 flex-1 flex-col gap-3 p-3 md:gap-4 md:p-5 [&>*]:shrink-0">
        <h1 className="sr-only">{title}</h1>
        {description && (
          <p className="-mb-1 max-w-3xl text-[13px] text-muted-foreground">
            {description}
          </p>
        )}
        {children}
      </div>
    </>
  )
}
