import { CompassIcon } from "lucide-react"
import { Link } from "react-router"

import { SiteHeader } from "@/components/site-header"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export function NotFoundPage() {
  return (
    <>
      <SiteHeader crumbs={[{ label: "Not found" }]} />
      <main className="flex flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CompassIcon />
            </EmptyMedia>
            <EmptyTitle>Page not found</EmptyTitle>
            <EmptyDescription>
              This part of the admin portal doesn’t exist (yet).
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/">Go to the dashboard</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </main>
    </>
  )
}
