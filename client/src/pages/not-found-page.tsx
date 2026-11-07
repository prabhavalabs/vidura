import { CompassIcon } from "lucide-react"
import { Link } from "react-router"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useT } from "@/lib/i18n"

export function NotFoundPage() {
  const t = useT()
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CompassIcon />
        </EmptyMedia>
        <EmptyTitle>{t.notFound.title}</EmptyTitle>
        <EmptyDescription>{t.notFound.body}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link to="/">{t.notFound.home}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}
