// API client. The API lives on its own host (VIDURA_API_URL); the portal
// calls it cross-origin with the session cookie. The server only accepts
// writes whose Origin header is this portal's address.

/**
 * The API's origin. In development it comes from VITE_API_URL; a production
 * build reads the <meta name="vidura-api-url"> the server fills in, so one
 * build works for every deployment.
 */
function resolveApiUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL as string | undefined
  if (fromEnv) return fromEnv.replace(/\/$/, "")
  const meta = document
    .querySelector<HTMLMetaElement>('meta[name="vidura-api-url"]')
    ?.content.trim()
  if (meta && !meta.startsWith("__")) return meta.replace(/\/$/, "")
  return window.location.origin
}

export const apiUrl = resolveApiUrl()

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

async function request<T>(
  method: Method,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(apiUrl + path, {
    method,
    credentials: "include",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    const error = (
      data as { error?: { code?: string; message?: string } } | null
    )?.error
    throw new ApiError(
      response.status,
      error?.code ?? "http_error",
      error?.message ?? `Request failed (${response.status})`
    )
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) =>
    request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T = void>(path: string) => request<T>("DELETE", path),
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong."
}
