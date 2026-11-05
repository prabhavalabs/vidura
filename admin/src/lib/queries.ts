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
  AuditPage,
  Invite,
  Overview,
  Role,
  User,
  UserStatus,
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
      window.location.assign("/admin/login")
    },
  })
}

export function useDevSignIn() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (email: string) =>
      api.post<{ user: User }>("/auth/dev-login", { email }),
    onSuccess: (data) => client.setQueryData(keys.me, data.user),
  })
}

// --- dashboard ------------------------------------------------------------

export function useOverview() {
  return useQuery({
    queryKey: keys.overview,
    queryFn: () => api.get<Overview>("/admin/api/overview"),
    refetchInterval: 30_000,
  })
}

// --- users ----------------------------------------------------------------

export function useUsers() {
  return useQuery({
    queryKey: keys.users,
    queryFn: () =>
      api.get<{ users: AdminUser[] }>("/admin/api/users").then((r) => r.users),
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
        `/admin/api/users/${encodeURIComponent(input.id)}`,
        {
          role: input.role,
          status: input.status,
        }
      )
  )
}

export function useDeleteUser() {
  return useAccountMutation((id: string) =>
    api.delete(`/admin/api/users/${encodeURIComponent(id)}`)
  )
}

// --- invites --------------------------------------------------------------

export function useInvites() {
  return useQuery({
    queryKey: keys.invites,
    queryFn: () =>
      api
        .get<{ invites: Invite[] }>("/admin/api/invites")
        .then((r) => r.invites),
  })
}

export function useCreateInvite() {
  return useAccountMutation((email: string) =>
    api.post<{ invite: Invite }>("/admin/api/invites", { email })
  )
}

export function useDeleteInvite() {
  return useAccountMutation((email: string) =>
    api.delete(`/admin/api/invites/${encodeURIComponent(email)}`)
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
      return api.get<AuditPage>(`/admin/api/audit?${params}`)
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
}
