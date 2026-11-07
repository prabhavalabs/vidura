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
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/api"
import { useAuthMethods, usePasswordSignIn } from "@/lib/queries"

// Reasons the server can send the browser back to /login with.
const signInErrors: Record<string, string> = {
  method_not_allowed: "The admin portal signs in with an email and password.",
  disabled:
    "This account has been disabled. Ask the owner if you think that’s a mistake.",
  server_error: "Something went wrong on the server. Please try again.",
}

// The admin portal signs in with an email and password only.
export function LoginForm({
  className,
  error,
  onSignedIn,
  ...props
}: React.ComponentProps<"div"> & {
  error: string | null
  onSignedIn: () => void
}) {
  const methods = useAuthMethods()
  const passwordSignIn = usePasswordSignIn()
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const message = error
    ? (signInErrors[error] ?? signInErrors.server_error)
    : null
  const unavailable = methods.isSuccess && !methods.data.password

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Vidura admin</CardTitle>
          <CardDescription>
            Sign in with your email and password
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              passwordSignIn.mutate(
                { email, password },
                { onSuccess: onSignedIn }
              )
            }}
          >
            <FieldGroup>
              {(message || unavailable) && (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Couldn’t sign you in</AlertTitle>
                  <AlertDescription>
                    {unavailable
                      ? "Password sign-in isn’t enabled on this server."
                      : message}
                  </AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={passwordSignIn.isError || undefined}
                  required
                />
              </Field>
              <Field data-invalid={passwordSignIn.isError || undefined}>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={passwordSignIn.isError || undefined}
                  required
                />
                {passwordSignIn.isError && (
                  <FieldDescription>
                    {errorMessage(passwordSignIn.error)}
                  </FieldDescription>
                )}
              </Field>
              <Field>
                <Button
                  type="submit"
                  disabled={passwordSignIn.isPending || unavailable}
                >
                  {passwordSignIn.isPending && <Spinner />}
                  Sign in
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        Vidura admin is private. Only the owner’s accounts can sign in.
      </FieldDescription>
    </div>
  )
}
