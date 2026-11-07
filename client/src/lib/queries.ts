import {
  keepPreviousData,
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api, ApiError, apiUrl } from "@/lib/api"
import type {
  Added,
  ChatMessage,
  Insight,
  InsightKind,
  Job,
  JobKind,
  LibraryPage,
  LibraryParams,
  Picture,
  Thread,
  User,
  Video,
  VideoDetail,
} from "@/lib/types"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Never retry auth failures or missing videos; retry other errors once.
      retry: (count, error) =>
        !(
          error instanceof ApiError && [401, 403, 404].includes(error.status)
        ) && count < 1,
      refetchOnWindowFocus: true,
    },
  },
})

export const keys = {
  me: ["me"] as const,
  videos: ["videos"] as const,
  library: (params: LibraryParams) => ["videos", "list", params] as const,
  libraryFeed: (params: Omit<LibraryParams, "page">) =>
    ["videos", "feed", params] as const,
  video: (id: string) => ["videos", "one", id] as const,
}

// While a video is being processed its progress is polled quickly;
// otherwise the library refreshes slowly in the background.
const LIVE_MS = 2_000
const IDLE_MS = 30_000

/** A video that is still waiting for, or in the middle of, a run. */
export function isProcessing(video: Pick<Video, "status" | "lastJob">) {
  const job = video.lastJob
  if (job && (job.status === "queued" || job.status === "running")) return true
  return video.status !== "ready" && video.status !== "failed"
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

/** The address that starts Google sign-in and comes back to `next`. */
export function googleSignInUrl(next: string) {
  const query = new URLSearchParams({ app: "client", next })
  return `${apiUrl}/auth/google/start?${query}`
}

// --- library --------------------------------------------------------------

/** A page of the library; the previous page stays on screen while the
 * next one loads. */
export function useLibrary(params: LibraryParams, enabled = true) {
  return useQuery({
    enabled,
    queryKey: keys.library(params),
    queryFn: () => {
      const query = new URLSearchParams({
        page: String(params.page),
        size: String(params.size),
      })
      if (params.q) query.set("q", params.q)
      if (params.filter !== "all") query.set("filter", params.filter)
      return api.get<LibraryPage>(`/api/videos?${query}`)
    },
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.videos.some(isProcessing) ? LIVE_MS : IDLE_MS,
  })
}

function libraryQuery(params: LibraryParams) {
  const query = new URLSearchParams({
    page: String(params.page),
    size: String(params.size),
  })
  if (params.q) query.set("q", params.q)
  if (params.filter !== "all") query.set("filter", params.filter)
  return api.get<LibraryPage>(`/api/videos?${query}`)
}

/**
 * The library as one growing list, for phones: the next server page loads as
 * the reader nears the end (infinite scroll).
 */
export function useLibraryFeed(
  params: Omit<LibraryParams, "page">,
  enabled = true
) {
  return useInfiniteQuery({
    enabled,
    queryKey: keys.libraryFeed(params),
    queryFn: ({ pageParam }) => libraryQuery({ ...params, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page * last.size < last.total ? last.page + 1 : undefined,
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.videos.some(isProcessing))
        ? LIVE_MS
        : IDLE_MS,
  })
}

export function useVideo(id: string) {
  return useQuery({
    queryKey: keys.video(id),
    queryFn: () => api.get<VideoDetail>(`/api/videos/${id}`),
    refetchInterval: (query) =>
      query.state.data && isProcessing(query.state.data.video)
        ? LIVE_MS
        : false,
  })
}

export function useAddVideo() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (url: string) => api.post<Added>("/api/videos", { url }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.videos }),
  })
}

export function useDeleteVideo() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/videos/${id}`),
    onSuccess: (_, id) => {
      client.removeQueries({ queryKey: keys.video(id) })
      return client.invalidateQueries({ queryKey: keys.videos })
    },
  })
}

export function useRequestRun(id: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (kind: JobKind) =>
      api.post<{ job: Job }>(`/api/videos/${id}/jobs`, { kind }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.videos }),
  })
}

// --- preferences ----------------------------------------------------------

export function useSetLocale() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (locale: User["locale"]) =>
      api.patch<{ user: User }>("/api/me/preferences", { locale }),
    onSuccess: (data) => client.setQueryData(keys.me, data.user),
  })
}

// --- learning ---------------------------------------------------------------

export const learnKeys = {
  insight: (id: string, kind: InsightKind, locale: string) =>
    ["videos", "one", id, "insight", kind, locale] as const,
  videoChat: (id: string) => ["videos", "one", id, "chat"] as const,
  pictures: (id: string) => ["videos", "one", id, "pictures"] as const,
  chats: ["chats"] as const,
  chat: (id: string) => ["chats", id] as const,
}

/** Study notes; polled while they're being made. */
export function useInsight<T>(id: string, kind: InsightKind, locale: string) {
  return useQuery({
    queryKey: learnKeys.insight(id, kind, locale),
    queryFn: () =>
      api.get<Insight<T>>(
        `/api/videos/${id}/insights/${kind}?locale=${locale}`
      ),
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? 3_000 : false,
  })
}

export function useMakeInsight(id: string, kind: InsightKind, locale: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<Insight>(`/api/videos/${id}/insights/${kind}`, { locale }),
    onSuccess: (data) =>
      client.setQueryData(learnKeys.insight(id, kind, locale), data),
  })
}

export function useVideoChat(id: string) {
  return useQuery({
    queryKey: learnKeys.videoChat(id),
    queryFn: () =>
      api.get<{ thread: Thread | null; messages: ChatMessage[] }>(
        `/api/videos/${id}/chat`
      ),
  })
}

export type AskInput = {
  question: string
  locale: string
  voice?: boolean
  threadId?: string
  /** A video picked with "/" in the composer. */
  attachedVideoId?: string
}

export type AskResult = { thread: Thread; messages: ChatMessage[] }

/** Asks about one video (videoId) or the whole library. */
export function useAsk(videoId?: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: AskInput) =>
      api.post<AskResult>(
        videoId ? `/api/videos/${videoId}/chat` : "/api/chats",
        input
      ),
    onSuccess: (data) => {
      if (videoId) {
        client.setQueryData(
          learnKeys.videoChat(videoId),
          (old: { messages: ChatMessage[] } | undefined) => ({
            thread: data.thread,
            messages: [...(old?.messages ?? []), ...data.messages],
          })
        )
      } else {
        client.setQueryData(
          learnKeys.chat(data.thread.id),
          (old: { messages: ChatMessage[] } | undefined) => ({
            messages: [...(old?.messages ?? []), ...data.messages],
          })
        )
        void client.invalidateQueries({ queryKey: learnKeys.chats })
      }
    },
  })
}

/** Where a conversation's messages are cached: a video's chat, or a
 * library chat. */
export type ChatPlace = { videoId: string } | { threadId: string }

/** Puts a newer copy of a message (an answer that moved on) in the cache. */
export function putMessage(place: ChatPlace, message: ChatMessage) {
  const key =
    "videoId" in place
      ? learnKeys.videoChat(place.videoId)
      : learnKeys.chat(place.threadId)
  queryClient.setQueryData(
    key,
    (old: { messages: ChatMessage[] } | undefined) =>
      old && {
        ...old,
        messages: old.messages.map((m) => (m.id === message.id ? message : m)),
      }
  )
  if ("threadId" in place && message.status !== "streaming") {
    // The chat moved up the list.
    void queryClient.invalidateQueries({ queryKey: learnKeys.chats })
  }
}

/** Stops an answer being written; what was written is kept. */
export function useStopAnswer(place: ChatPlace) {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ message: ChatMessage }>(`/api/messages/${id}/stop`),
    onSuccess: (data) => putMessage(place, data.message),
  })
}

/** Writes a failed or stopped answer again. */
export function useRetryAnswer(place: ChatPlace) {
  return useMutation({
    mutationFn: ({ id, locale }: { id: string; locale: string }) =>
      api.post<{ message: ChatMessage }>(`/api/messages/${id}/retry`, {
        locale,
      }),
    onSuccess: (data) => putMessage(place, data.message),
  })
}

/** Ready videos matching a search, for the composer's "/" picker. */
export function useVideoSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ["videos", "search", q] as const,
    queryFn: () => {
      const query = new URLSearchParams({
        page: "1",
        size: "8",
        filter: "ready",
      })
      if (q) query.set("q", q)
      return api.get<LibraryPage>(`/api/videos?${query}`)
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useChats() {
  return useQuery({
    queryKey: learnKeys.chats,
    queryFn: () =>
      api.get<{ threads: Thread[] }>("/api/chats").then((r) => r.threads),
  })
}

export function useChat(id: string | undefined) {
  return useQuery({
    queryKey: learnKeys.chat(id ?? ""),
    queryFn: () => api.get<{ messages: ChatMessage[] }>(`/api/chats/${id}`),
    enabled: Boolean(id),
  })
}

export function useRenameChat() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch(`/api/chats/${id}`, { title }),
    onSuccess: () => client.invalidateQueries({ queryKey: learnKeys.chats }),
  })
}

export function useDeleteChat() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/chats/${id}`),
    onSuccess: (_, id) => {
      client.removeQueries({ queryKey: learnKeys.chat(id) })
      return client.invalidateQueries({ queryKey: learnKeys.chats })
    },
  })
}

/** Pictures for a video; polled while one is being drawn. */
export function usePictures(id: string) {
  return useQuery({
    queryKey: learnKeys.pictures(id),
    queryFn: () =>
      api
        .get<{ pictures: Picture[] }>(`/api/videos/${id}/pictures`)
        .then((r) => r.pictures),
    refetchInterval: (query) =>
      query.state.data?.some((p) => p.status === "pending") ? 4_000 : false,
  })
}

export function useMakePicture(id: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { concept: string; locale: string }) =>
      api.post<{ picture: Picture }>(`/api/videos/${id}/pictures`, input),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: learnKeys.pictures(id) }),
  })
}

export function useDeletePicture(videoId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/pictures/${id}`),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: learnKeys.pictures(videoId) }),
  })
}
