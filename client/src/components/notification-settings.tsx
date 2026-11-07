import * as React from "react"
import { BellIcon, BellOffIcon, RefreshCwIcon, SendIcon } from "lucide-react"
import { toast } from "sonner"

import { IosInstallSteps } from "@/components/install-app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { api, errorMessage } from "@/lib/api"
import { useT } from "@/lib/i18n"
import {
  disablePush,
  enablePush,
  isAndroid,
  isIOS,
  pushState,
  type PushState,
} from "@/lib/pwa"

/** Settings: this device's notifications, in every state they can be in. */
export function NotificationsCard() {
  const t = useT()
  const [state, setState] = React.useState<PushState | "loading">("loading")
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [showSteps, setShowSteps] = React.useState(false)

  const check = React.useCallback(async () => {
    try {
      setState(await pushState())
    } catch {
      setState("off")
    }
  }, [])

  React.useEffect(() => {
    let live = true
    pushState()
      .then((value) => live && setState(value))
      .catch(() => live && setState("off"))
    // Someone who unblocked notifications in the browser's settings comes
    // back to this page: look again.
    const onVisible = () => {
      if (document.visibilityState === "visible") check()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      live = false
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [check])

  async function toggle(on: boolean) {
    setBusy(true)
    try {
      setState(on ? await enablePush() : await disablePush())
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setTesting(true)
    try {
      const { sent } = await api.post<{ sent: number }>("/api/push/test")
      if (sent > 0) toast(t.notify.testSent)
      else toast.warning(t.notify.testNone)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setTesting(false)
    }
  }

  const blockedHelp = isIOS()
    ? t.notify.blockedIos
    : isAndroid()
      ? t.notify.blockedAndroid
      : t.notify.blockedDesktop

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellIcon className="size-4" />
          {t.notify.title}
        </CardTitle>
        <CardDescription>{t.notify.hint}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {state === "needs-install" && (
            <Alert>
              <AlertDescription className="flex flex-col items-start gap-3">
                {t.notify.needsInstall}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowSteps(true)}
                >
                  {t.notify.needsInstallButton}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {state === "unsupported" && (
            <Alert>
              <BellOffIcon />
              <AlertDescription>{t.notify.unsupported}</AlertDescription>
            </Alert>
          )}
          {state === "blocked" && (
            <Alert variant="destructive">
              <BellOffIcon />
              <AlertTitle>{t.notify.blockedTitle}</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                {blockedHelp}
                <Button variant="outline" size="sm" onClick={check}>
                  <RefreshCwIcon />
                  {t.notify.recheck}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {(state === "on" || state === "off" || state === "loading") && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="push-on">{t.notify.switchLabel}</FieldLabel>
                {state !== "loading" && (
                  <FieldDescription>
                    {state === "on" ? t.notify.onHint : t.notify.offHint}
                  </FieldDescription>
                )}
              </FieldContent>
              {state === "loading" || busy ? (
                <Spinner />
              ) : (
                <Switch
                  id="push-on"
                  checked={state === "on"}
                  onCheckedChange={toggle}
                />
              )}
            </Field>
          )}
          {state === "on" && (
            <Button
              variant="outline"
              className="self-start"
              onClick={test}
              disabled={testing}
            >
              {testing ? <Spinner /> : <SendIcon />}
              {t.notify.sendTest}
            </Button>
          )}
        </FieldGroup>
      </CardContent>
      <IosInstallSteps open={showSteps} onOpenChange={setShowSteps} />
    </Card>
  )
}
