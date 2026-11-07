import { AlertCircleIcon } from "lucide-react"
import { Navigate, useSearchParams } from "react-router"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { FieldDescription } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLocale, type Locale } from "@/lib/i18n"
import { googleSignInUrl, useMe } from "@/lib/queries"

/** Where to go after sign-in: a path inside the portal, or the library. */
function safeNext(value: string | null): string {
  if (
    value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
  )
    return value
  return "/"
}

// The client portal signs in with Google only.
export function LoginPage() {
  const { t, locale, setLocale } = useLocale()
  const [params] = useSearchParams()
  const me = useMe()
  const next = safeNext(params.get("next"))
  const error = params.get("error")
  const message = error
    ? (t.login.errors[error] ?? t.login.errors.server_error)
    : null

  if (me.data) return <Navigate to={next} replace />

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-medium">
            <img src="/vidura-icon.svg" alt="" className="size-7 rounded-md" />
            Vidura
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={locale}
            onValueChange={(value) => value && setLocale(value as Locale)}
            aria-label={t.settings.language}
          >
            <ToggleGroupItem value="en">EN</ToggleGroupItem>
            <ToggleGroupItem value="si">සිං</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">{t.login.welcome}</CardTitle>
            <CardDescription>{t.appTagline}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {message && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>{t.login.failed}</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}
            <Button size="lg" asChild>
              <a href={googleSignInUrl(next)}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                    fill="currentColor"
                  />
                </svg>
                {t.login.google}
              </a>
            </Button>
          </CardContent>
        </Card>
        <FieldDescription className="px-6 text-center">
          {t.login.private}
        </FieldDescription>
      </div>
    </div>
  )
}
