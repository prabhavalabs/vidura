import * as React from "react"
import { AlertCircleIcon } from "lucide-react"
import { cn } from "cn"

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
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/api"
import { useDevSignIn } from "@/lib/queries"

const signInErrors: Record<string, string> = {
  not_invited:
    "This Google account hasn’t been invited. Ask the owner to invite your email address.",
  disabled:
    "This account has been disabled. Ask the owner if you think that’s a mistake.",
  unverified_email: "Your Google account’s email address isn’t verified yet.",
  account_conflict:
    "A different Google account is already linked to this email address.",
  session_expired:
    "The sign-in took too long or started in another browser. Please try again.",
  cancelled: "Sign-in was cancelled.",
  google_failed: "Google sign-in didn’t complete. Please try again.",
  google_unavailable: "Couldn’t reach Google. Please try again in a moment.",
  google_not_configured: "Google sign-in isn’t configured on this server.",
  server_error: "Something went wrong on the server. Please try again.",
}

export function LoginForm({
  className,
  next,
  error,
  onSignedIn,
  ...props
}: React.ComponentProps<"div"> & {
  next: string
  error: string | null
  onSignedIn: () => void
}) {
  const devSignIn = useDevSignIn()
  const [email, setEmail] = React.useState("")
  const message = error
    ? (signInErrors[error] ?? signInErrors.server_error)
    : null
  const googleHref = `/auth/google/start?next=${encodeURIComponent(next)}`

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Vidura admin</CardTitle>
          <CardDescription>
            Sign in with the Google account the owner invited
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {message && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>Couldn’t sign you in</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}
            <Field>
              <Button variant="outline" asChild>
                <a href={googleHref}>
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
                  Continue with Google
                </a>
              </Button>
            </Field>

            {import.meta.env.DEV && (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  devSignIn.mutate(email, { onSuccess: onSignedIn })
                }}
              >
                <FieldGroup>
                  <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                    Local development
                  </FieldSeparator>
                  <Field data-invalid={devSignIn.isError || undefined}>
                    <FieldLabel htmlFor="dev-email">Email</FieldLabel>
                    <Input
                      id="dev-email"
                      type="email"
                      placeholder="owner@example.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      aria-invalid={devSignIn.isError || undefined}
                      required
                    />
                    <FieldDescription>
                      {devSignIn.isError
                        ? errorMessage(devSignIn.error)
                        : "Signs in an allowed email without Google. Only works when the server runs with VIDURA_DEV_LOGIN=true."}
                    </FieldDescription>
                  </Field>
                  <Field>
                    <Button type="submit" disabled={devSignIn.isPending}>
                      {devSignIn.isPending && <Spinner />}
                      Sign in
                    </Button>
                  </Field>
                </FieldGroup>
              </form>
            )}
          </FieldGroup>
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        Vidura is private. Only invited family members can sign in.
      </FieldDescription>
    </div>
  )
}
