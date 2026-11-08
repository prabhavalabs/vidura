import type * as React from "react"
import { Loader2Icon } from "lucide-react"

import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"

/**
 * A tab's icon with a tiny spinner on its bottom-right corner while
 * something in that tab is still being made, so it shows from other tabs.
 */
export function BusyIcon({
  busy,
  children,
}: {
  busy: boolean
  children: React.ReactNode
}) {
  const t = useT()
  return (
    <span className={cn("relative inline-flex shrink-0", busy && "mr-1")}>
      {children}
      {busy && (
        <span
          role="status"
          className="absolute -right-1.5 -bottom-1.5 flex size-3 items-center justify-center rounded-full bg-background text-selected-foreground ring-1 ring-selected-border"
        >
          <Loader2Icon className="size-2.5! animate-spin" aria-hidden />
          <span className="sr-only">{`${t.tabs.busy}: `}</span>
        </span>
      )}
    </span>
  )
}
