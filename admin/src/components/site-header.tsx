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

export function SiteHeader({
  crumbs,
  actions,
}: {
  crumbs: Crumb[]
  actions?: React.ReactNode
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex w-full items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mr-2 data-[orientation=vertical]:h-4"
        />
        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1
              return (
                <span key={`${crumb.label}-${index}`} className="contents">
                  <BreadcrumbItem
                    className={last ? undefined : "hidden md:block"}
                  >
                    {last || !crumb.to ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link to={crumb.to}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {!last && <BreadcrumbSeparator className="hidden md:block" />}
                </span>
              )
            })}
          </BreadcrumbList>
        </Breadcrumb>
        {actions && (
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  )
}

/** Standard page body: header, then padded content. */
export function Page({
  crumbs,
  actions,
  title,
  description,
  children,
}: {
  crumbs: Crumb[]
  actions?: React.ReactNode
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
        {children}
      </main>
    </>
  )
}
