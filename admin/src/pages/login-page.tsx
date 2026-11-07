import { Navigate, useNavigate, useSearchParams } from "react-router"

import { LoginForm } from "@/components/login-form"
import { useMe } from "@/lib/queries"

/** Where to go after sign-in: a path inside the portal, or the dashboard. */
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

export function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const me = useMe()
  const next = safeNext(params.get("next"))

  if (me.data?.role === "superuser") return <Navigate to={next} replace />

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <img src="/vidura-icon.svg" alt="" className="size-7 rounded-md" />
          Vidura
        </div>
        <LoginForm
          error={params.get("error")}
          onSignedIn={() => navigate(next, { replace: true })}
        />
      </div>
    </div>
  )
}
