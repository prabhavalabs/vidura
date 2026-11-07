import * as React from "react"
import { DownloadIcon, ShareIcon, SquarePlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useT } from "@/lib/i18n"
import { isIOS, isStandalone, useInstall } from "@/lib/pwa"

/**
 * Whether this device can install Vidura, and a function that does it:
 * the browser's own prompt on Android and desktop Chrome/Edge, or the
 * Share → Add to Home Screen steps on iPhone and iPad (Safari has no
 * prompt to call).
 */
export function useInstallApp() {
  const { canInstall, install } = useInstall()
  const [showSteps, setShowSteps] = React.useState(false)
  const standalone = isStandalone()
  const ios = isIOS()
  const available = !standalone && (canInstall || ios)
  const start = React.useCallback(() => {
    if (canInstall) install()
    else setShowSteps(true)
  }, [canInstall, install])
  const dialog = <IosInstallSteps open={showSteps} onOpenChange={setShowSteps} />
  return { available, standalone, start, dialog }
}

export function IosInstallSteps({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const ios = isIOS()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ios ? t.install.iosTitle : t.install.title}</DialogTitle>
          <DialogDescription>
            {ios ? t.install.iosIntro : t.install.otherBrowser}
          </DialogDescription>
        </DialogHeader>
        {ios && (
          <ol className="flex flex-col gap-3 text-sm">
            <Step n={1} icon={<ShareIcon className="size-4" />}>
              {t.install.iosStep1}
            </Step>
            <Step n={2} icon={<SquarePlusIcon className="size-4" />}>
              {t.install.iosStep2}
            </Step>
            <Step n={3}>{t.install.iosStep3}</Step>
          </ol>
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t.install.done}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Step({
  n,
  icon,
  children,
}: {
  n: number
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
        {n}
      </span>
      <span className="flex flex-1 items-center gap-2 pt-0.5">
        <span>{children}</span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </span>
    </li>
  )
}

/** Settings: install the app, or confirm it's installed. */
export function InstallCard() {
  const t = useT()
  const { available, standalone, start, dialog } = useInstallApp()
  if (!available && !standalone) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DownloadIcon className="size-4" />
          {t.install.title}
        </CardTitle>
        <CardDescription>
          {standalone ? t.install.installed : t.install.hint}
        </CardDescription>
      </CardHeader>
      {available && (
        <CardContent>
          <Button onClick={start}>
            <DownloadIcon />
            {t.install.button}
          </Button>
          {dialog}
        </CardContent>
      )}
    </Card>
  )
}
