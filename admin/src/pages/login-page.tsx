import { Navigate, useNavigate, useSearchParams } from "react-router"

import { LoginForm } from "@/components/login-form"
import { useMe } from "@/lib/queries"

/** Where to go after sign-in: a path inside the admin portal, or the dashboard. */
function safeNext(value: string | null): string {
  if (value && value.startsWith("/admin") && !value.startsWith("//"))
    return value
  return "/admin"
}

export function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const me = useMe()
  const next = safeNext(params.get("next"))
  const inPortal = next.replace(/^\/admin/, "") || "/"

  if (me.data?.role === "superuser") return <Navigate to={inPortal} replace />

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <img
            src="/admin/vidura-icon.svg"
            alt=""
            className="size-7 rounded-md"
          />
          Vidura
        </div>
        <LoginForm
          next={next}
          error={params.get("error")}
          onSignedIn={() => navigate(inPortal, { replace: true })}
        />
      </div>
    </div>
  )
}
