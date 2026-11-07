import {
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api, ApiError } from "@/lib/api"
import type {
  AdminUser,
  AIModel,
  AIStatus,
  AITestResult,
  AppSettings,
  AuditListPage,
  AuditPage,
  Device,
  Invite,
  Job,
  Overview,
  PairingCode,
  Role,
  Stats,
  SystemStatus,
  User,
  UserStatus,
  Video,
  VideoDetail,
} from "@/lib/types"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Never retry auth failures; retry other errors once.
      retry: (count, error) =>
        !(
          error instanceof ApiError && [401, 403, 404].includes(error.status)
        ) && count < 1,
      refetchOnWindowFocus: true,
    },
  },
})

/** Query keys, one factory per resource, so invalidation stays precise. */
export const keys = {
  me: ["me"] as const,
  overview: ["admin", "overview"] as const,
  users: ["admin", "users"] as const,
  invites: ["admin", "invites"] as const,
  audit: (action: string) => ["admin", "audit", action] as const,
  stats: ["admin", "stats"] as const,
  videos: ["admin", "videos"] as const,
  video: (id: string) => ["admin", "videos", id] as const,
  jobs: (status: string) => ["admin", "jobs", status] as const,
  system: ["admin", "system"] as const,
  ai: ["admin", "ai"] as const,
  devices: ["admin", "devices"] as const,
  settings: ["admin", "settings"] as const,
  auditAll: ["admin", "audit"] as const,
}

// --- session --------------------------------------------------------------

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api.get<{ user: User }>("/api/me").then((r) => r.user),
    staleTime: 60_000,
  })
}

export function useSignOut() {
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSettled: () => {
      queryClient.clear()
      window.location.assign("/login")
    },
  })
}

/** Which sign-in methods the server offers. */
export function useAuthMethods() {
  return useQuery({
    queryKey: ["auth", "methods"] as const,
    queryFn: () =>
      api.get<{ google: boolean; password: boolean }>("/auth/methods"),
    staleTime: Infinity,
  })
}

/** Local password sign-in. The server only offers it in development. */
export function usePasswordSignIn() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<{ user: User }>("/auth/password", input),
    onSuccess: (data) => client.setQueryData(keys.me, data.user),
  })
}

// --- dashboard ------------------------------------------------------------

export function useOverview() {
  return useQuery({
    queryKey: keys.overview,
    queryFn: () => api.get<Overview>("/api/admin/overview"),
    refetchInterval: 30_000,
  })
}

// --- users ----------------------------------------------------------------

export function useUsers() {
  return useQuery({
    queryKey: keys.users,
    queryFn: () =>
      api.get<{ users: AdminUser[] }>("/api/admin/users").then((r) => r.users),
  })
}

function useAccountMutation<TVariables, TResult>(
  fn: (variables: TVariables) => Promise<TResult>
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.users }),
        client.invalidateQueries({ queryKey: keys.invites }),
        client.invalidateQueries({ queryKey: keys.overview }),
        client.invalidateQueries({ queryKey: keys.auditAll }),
      ]),
  })
}

export function useUpdateUser() {
  return useAccountMutation(
    (input: { id: string; role?: Role; status?: UserStatus }) =>
      api.patch<{ user: User }>(
        `/api/admin/users/${encodeURIComponent(input.id)}`,
        {
          role: input.role,
          status: input.status,
        }
      )
  )
}

export function useDeleteUser() {
  return useAccountMutation((id: string) =>
    api.delete(`/api/admin/users/${encodeURIComponent(id)}`)
  )
}

// --- invites --------------------------------------------------------------

export function useInvites() {
  return useQuery({
    queryKey: keys.invites,
    queryFn: () =>
      api
        .get<{ invites: Invite[] }>("/api/admin/invites")
        .then((r) => r.invites),
  })
}

export function useCreateInvite() {
  return useAccountMutation((email: string) =>
    api.post<{ invite: Invite }>("/api/admin/invites", { email })
  )
}

export function useDeleteInvite() {
  return useAccountMutation((email: string) =>
    api.delete(`/api/admin/invites/${encodeURIComponent(email)}`)
  )
}

// --- audit log ------------------------------------------------------------

export function useAuditLog(action: string) {
  return useInfiniteQuery({
    queryKey: keys.audit(action),
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" })
      if (pageParam) params.set("cursor", pageParam)
      if (action) params.set("action", action)
      return api.get<AuditPage>(`/api/admin/audit?${params}`)
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
}

// --- catalog --------------------------------------------------------------

export function useStats() {
  return useQuery({
    queryKey: keys.stats,
    queryFn: () => api.get<Stats>("/api/admin/stats"),
    refetchInterval: 60_000,
  })
}

// While a run is waiting or working, lists refresh every 2 s so its
// progress moves; otherwise every 30 s.
const LIVE_MS = 2_000
const IDLE_MS = 30_000

function openRun(job: { status: string } | null | undefined): boolean {
  return !!job && (job.status === "queued" || job.status === "running")
}

export function useVideos() {
  return useQuery({
    queryKey: keys.videos,
    queryFn: () =>
      api.get<{ videos: Video[] }>("/api/admin/videos").then((r) => r.videos),
    refetchInterval: (query) =>
      query.state.data?.some((video) => openRun(video.lastJob))
        ? LIVE_MS
        : IDLE_MS,
  })
}

export function useVideo(id: string) {
  return useQuery({
    queryKey: keys.video(id),
    queryFn: () =>
      api.get<VideoDetail>(`/api/admin/videos/${encodeURIComponent(id)}`),
    refetchInterval: (query) =>
      query.state.data?.jobs.some(openRun) ? LIVE_MS : false,
  })
}

export function useJobs(status: string) {
  return useQuery({
    queryKey: keys.jobs(status),
    queryFn: () => {
      const params = new URLSearchParams()
      if (status) params.set("status", status)
      return api
        .get<{ jobs: Job[] }>(`/api/admin/jobs?${params}`)
        .then((r) => r.jobs)
    },
    refetchInterval: (query) =>
      query.state.data?.some(openRun) ? LIVE_MS : IDLE_MS,
  })
}

export function useSystem() {
  return useQuery({
    queryKey: keys.system,
    queryFn: () => api.get<SystemStatus>("/api/admin/system"),
    refetchInterval: 30_000,
  })
}

// --- ChatGPT subscription -------------------------------------------------

export function useAIStatus() {
  return useQuery({
    queryKey: keys.ai,
    queryFn: () => api.get<AIStatus>("/api/admin/ai"),
    // Poll quickly while a device sign-in waits for the code.
    refetchInterval: (query) =>
      query.state.data?.state === "connecting" ? 2_000 : 30_000,
  })
}

function useAIMutation<T, V = void>(fn: (vars: V) => Promise<T>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      client.invalidateQueries({ queryKey: keys.ai })
      client.invalidateQueries({ queryKey: keys.auditAll })
    },
  })
}

export function useStartAILogin() {
  return useAIMutation(() =>
    api.post<{ login: AIStatus["login"] }>("/api/admin/ai/login")
  )
}

export function useCancelAILogin() {
  return useAIMutation(() => api.delete("/api/admin/ai/login"))
}

export function useAILogout() {
  return useAIMutation(() => api.post<void>("/api/admin/ai/logout"))
}

export function useAITest() {
  return useMutation({
    mutationFn: () => api.post<AITestResult>("/api/admin/ai/test"),
  })
}

export function useRefreshAI() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.get<AIStatus>("/api/admin/ai?fresh=1"),
    onSuccess: (data) => client.setQueryData(keys.ai, data),
  })
}

// --- transcription devices ------------------------------------------------

export function useDevices(fast = false) {
  return useQuery({
    queryKey: keys.devices,
    queryFn: () =>
      api
        .get<{ devices: Device[] }>("/api/admin/devices")
        .then((r) => r.devices),
    refetchInterval: fast ? 2_000 : 10_000,
  })
}

export function useCreatePairingCode() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<PairingCode>("/api/admin/devices/pairing-codes"),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.auditAll }),
  })
}

export function useRevokeDevice() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/admin/devices/${encodeURIComponent(id)}`),
    onSettled: () => {
      client.invalidateQueries({ queryKey: keys.devices })
      client.invalidateQueries({ queryKey: keys.auditAll })
    },
  })
}

// --- settings -------------------------------------------------------------

export function useAppSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: () => api.get<AppSettings>("/api/admin/settings"),
  })
}

export function useUpdateSettings() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (
      update: Partial<Omit<AppSettings, "ai">> & {
        ai?: Partial<AppSettings["ai"]>
      }
    ) => api.patch<AppSettings>("/api/admin/settings", update),
    onSuccess: (data) => client.setQueryData(keys.settings, data),
    onSettled: () => client.invalidateQueries({ queryKey: keys.auditAll }),
  })
}

export function useAIModels(enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "ai", "models"] as const,
    queryFn: () =>
      api
        .get<{ models: AIModel[] }>("/api/admin/ai/models")
        .then((r) => r.models),
    enabled,
    staleTime: 10 * 60_000,
  })
}

export function useInstallEngine() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { device: string; engine: string }) =>
      api.post<void>(
        `/api/admin/devices/${encodeURIComponent(input.device)}/engines/${encodeURIComponent(input.engine)}/install`
      ),
    onSettled: () => client.invalidateQueries({ queryKey: keys.devices }),
  })
}

// --- video and run actions ------------------------------------------------

function invalidateLibrary(client: ReturnType<typeof useQueryClient>) {
  client.invalidateQueries({ queryKey: keys.videos })
  client.invalidateQueries({ queryKey: ["admin", "jobs"] })
  client.invalidateQueries({ queryKey: keys.stats })
  client.invalidateQueries({ queryKey: keys.auditAll })
}

export function useDeleteVideo() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/admin/videos/${encodeURIComponent(id)}`),
    onSettled: () => invalidateLibrary(client),
  })
}

export type RunKind = "process_video" | "retranslate" | "retranscribe"

export function useRequestRun() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { video: string; kind: RunKind }) =>
      api.post<{ job: Job }>(
        `/api/admin/videos/${encodeURIComponent(input.video)}/jobs`,
        { kind: input.kind }
      ),
    onSettled: (_data, _error, input) => {
      invalidateLibrary(client)
      client.invalidateQueries({ queryKey: keys.video(input.video) })
    },
  })
}

export function useCancelRun() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ job: Job }>(
        `/api/admin/jobs/${encodeURIComponent(id)}/cancel`
      ),
    onSettled: () => {
      invalidateLibrary(client)
      client.invalidateQueries({ queryKey: ["admin", "videos"] })
    },
  })
}

export function useAuditPage(page: number, actions: string[]) {
  return useQuery({
    queryKey: ["admin", "audit", "page", page, actions.join(",")] as const,
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: "15" })
      if (actions.length > 0) params.set("action", actions.join(","))
      return api.get<AuditListPage>(`/api/admin/audit?${params}`)
    },
    placeholderData: (previous) => previous,
  })
}
