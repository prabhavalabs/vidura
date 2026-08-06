import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BadgeCheckIcon,
  BellIcon,
  BookOpenIcon,
  CaptionsIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CirclePlayIcon,
  ClockIcon,
  Trash2Icon,
  DownloadIcon,
  FilterIcon,
  HistoryIcon,
  HomeIcon,
  LinkIcon,
  ListVideoIcon,
  Loader2Icon,
  LogOutIcon,
  Maximize2Icon,
  MenuIcon,
  Minimize2Icon,
  MessageCircleIcon,
  CopyIcon,
  MoreHorizontalIcon,
  NotebookPenIcon,
  PauseIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SquarePenIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth, type SessionUser } from "@/features/auth/use-auth";
import {
  addVideoNote,
  chatSessionKeys,
  chatSettingsKey,
  createVideoJob,
  defaultChatSettings,
  deleteChatSession,
  deleteVideo,
  deleteVideoNote,
  fetchChatMessages,
  fetchChatSessions,
  fetchChatSettings,
  fetchLibraryVideos,
  fetchSessionMessages,
  fetchVideoNotes,
  fetchVideoTranscript,
  regenerateSubtitles,
  renameChatSession,
  resumeVideoJob,
  saveChatSettings,
  streamVideoChat,
  videoQueryKeys,
  type ChatSettings,
  type LibraryVideo,
} from "@/features/videos/api";
import { useVideoRealtime } from "@/features/videos/use-video-realtime";
import { translationCoveragePercent } from "@/features/videos/translation-coverage";
import {
  languageOptions,
  quickPrompts,
  type TranscriptSegment,
} from "@/features/videos/data";
import { Input } from "@/components/ui/input";
import { api, apiBaseUrl, isApiConfigured } from "@/lib/api";
import {
  disablePush,
  enablePush,
  isPushSubscribed,
  pushSupported,
} from "@/features/notifications/push";
import { parseTranscriptFile } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import {
  buildYouTubeWatchUrl,
  isYouTubeVideoId,
  parseYouTubeUrl,
} from "@/lib/youtube";
import {
  hexToRgbChannels,
  useAppStore,
  type AppView,
  type SubtitlePlacement,
} from "@/stores/app-store";
import {
  CartoonButton,
  MascotBubble,
  StickerCard,
  StickerPanel,
} from "@/components/vidura/cartoon";

const navItems: Array<{
  view: AppView;
  label: string;
  Icon: typeof HomeIcon;
  path: string;
}> = [
    { view: "library", label: "Library", Icon: HomeIcon, path: "/library" },
    { view: "add", label: "Add", Icon: PlusIcon, path: "/add" },
    { view: "watch", label: "Watch", Icon: CirclePlayIcon, path: "/watch" },
    { view: "chat", label: "Chats", Icon: MessageCircleIcon, path: "/chats" },
    { view: "settings", label: "Settings", Icon: SettingsIcon, path: "/settings" },
  ];

function App() {
  return (
    <TooltipProvider>
      <ViduraApp />
    </TooltipProvider>
  );
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function viewFromPath(pathname: string): AppView {
  if (pathname.startsWith("/add")) {
    return "add";
  }

  if (pathname.startsWith("/watch") || pathname.startsWith("/processing")) {
    return "watch";
  }

  if (pathname.startsWith("/chats")) {
    return "chat";
  }

  if (pathname.startsWith("/settings")) {
    return "settings";
  }

  return "library";
}

function navPathFor(view: AppView, selectedVideoId: string | null) {
  if (view === "watch" && selectedVideoId) {
    return `/watch/${selectedVideoId}`;
  }

  // "Chats" always opens the library-wide assistant; per-video chat lives on
  // the watch screen.
  return navItems.find((item) => item.view === view)?.path ?? "/library";
}

let youtubeIframeApiPromise: Promise<void> | null = null;

function loadYouTubeIframeApi() {
  if (window.YT?.Player) {
    return Promise.resolve();
  }

  if (youtubeIframeApiPromise) {
    return youtubeIframeApiPromise;
  }

  youtubeIframeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve();
    };

    if (document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      return;
    }

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("Could not load YouTube player."));
    document.head.append(script);
  });

  return youtubeIframeApiPromise;
}

function ViduraApp() {
  const selectedVideoId = useAppStore((state) => state.selectedVideoId);
  const setSelectedVideoId = useAppStore((state) => state.setSelectedVideoId);
  const location = useLocation();
  const auth = useAuth();
  const videosQuery = useLibraryVideos(auth.configured && Boolean(auth.session));
  // The chat page is a full-height flex column so its composer pins directly
  // above the bottom nav instead of floating in reserved padding.
  const isChatRoute = location.pathname.startsWith("/chats");

  useVideoRealtime(auth.configured && Boolean(auth.session));
  useStaleJobRecovery(videosQuery.data);

  useEffect(() => {
    if (!videosQuery.data) {
      return;
    }

    if (videosQuery.data.length === 0) {
      setSelectedVideoId(null);
      return;
    }

    const selectedVideoStillExists = videosQuery.data.some(
      (video) => video.id === selectedVideoId,
    );

    if (!selectedVideoStillExists) {
      setSelectedVideoId(videosQuery.data[0].id);
    }
  }, [selectedVideoId, setSelectedVideoId, videosQuery.data]);

  if (auth.loading) {
    return <LoadingScreen />;
  }

  if (auth.configured && !auth.session) {
    return <AuthScreen onSignIn={auth.signInWithGoogle} />;
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-[1760px] flex-col lg:flex-row">
        <DesktopSidebar />
        <main
          className={cn(
            "min-w-0 flex-1 px-4 pt-4 sm:px-6 lg:px-6 xl:px-7",
            isChatRoute
              // Clear the floating nav (~4.75rem mobile / ~5.25rem sm) plus a
              // small gap, instead of the 9rem reserved for scrolling pages,
              // and become a flex column so the chat section fills the exact
              // remaining height with its composer just above the nav.
              ? "flex flex-col overflow-hidden pb-[5.5rem] sm:pb-24 lg:pb-7"
              : "pb-36 sm:pb-40 lg:pb-7",
          )}
        >
          <TopBar />
          <Routes>
            <Route element={<Navigate replace to="/library" />} path="/" />
            <Route
              element={
                <LibraryScreen
                  error={videosQuery.error}
                  isPending={videosQuery.isPending}
                  videos={videosQuery.data ?? []}
                />
              }
              path="/library"
            />
            <Route element={<AddVideoScreen />} path="/add" />
            <Route element={<ProcessingRoute />} path="/processing/:videoId" />
            <Route
              element={<WatchScreen videos={videosQuery.data ?? []} />}
              path="/watch"
            />
            <Route
              element={<WatchScreen videos={videosQuery.data ?? []} />}
              path="/watch/:videoId"
            />
            <Route element={<ChatScreen />} path="/chats" />
            <Route element={<ChatScreen />} path="/chats/session/:threadId" />
            <Route element={<SettingsScreen />} path="/settings" />
            <Route element={<Navigate replace to="/library" />} path="*" />
          </Routes>
        </main>
        <MobileNav />
      </div>
    </div>
  );
}

function useLibraryVideos(enabled: boolean) {
  // Realtime (useVideoRealtime) is the primary update signal; polling is only
  // a safety net for missed events, so keep it slow to avoid competing
  // request storms while jobs are running.
  return useQuery({
    queryKey: videoQueryKeys.all,
    queryFn: fetchLibraryVideos,
    enabled,
    refetchInterval: (query) =>
      hasActiveVideoJob(query.state.data as LibraryVideo[] | undefined)
        ? 5_000
        : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
  });
}

// A running job that hasn't written a progress update in this long is
// considered dead: the edge runtime kills invocations at its wall-clock limit
// without running catch blocks, which used to leave jobs stuck at "running"
// forever. process-video-job is resumable (it only translates missing
// segments), so kicking it once brings the job back to life.
const STALE_JOB_THRESHOLD_MS = 150_000;
const STALE_JOB_RETRY_COOLDOWN_MS = 120_000;

function useStaleJobRecovery(videos: LibraryVideo[] | undefined) {
  const queryClient = useQueryClient();
  const attemptsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!videos) {
      return;
    }

    for (const video of videos) {
      const job = video.latestJob;

      if (!job || (job.status !== "running" && job.status !== "queued")) {
        continue;
      }

      const updatedAt = new Date(job.updatedAt).getTime();

      if (
        Number.isNaN(updatedAt) ||
        Date.now() - updatedAt < STALE_JOB_THRESHOLD_MS
      ) {
        continue;
      }

      const lastAttempt = attemptsRef.current.get(job.id) ?? 0;

      if (Date.now() - lastAttempt < STALE_JOB_RETRY_COOLDOWN_MS) {
        continue;
      }

      attemptsRef.current.set(job.id, Date.now());
      void resumeVideoJob(video.id).then(() =>
        queryClient.invalidateQueries({ queryKey: videoQueryKeys.all })
      ).catch((resumeError) => {
        console.error("Failed to resume stale job", job.id, resumeError);
      });
    }
  }, [videos, queryClient]);
}

function isVideoFailed(video: LibraryVideo | null | undefined) {
  return video?.status === "failed" || video?.latestJob?.status === "failed";
}

function hasActiveVideoJob(videos: LibraryVideo[] | undefined) {
  return videos?.some(isVideoStillProcessing) ?? false;
}

function isVideoStillProcessing(video: LibraryVideo | null | undefined) {
  if (!video || isVideoFailed(video)) {
    return false;
  }

  const jobStatus = video.latestJob?.status;

  return video.status !== "ready" || jobStatus === "queued" ||
    jobStatus === "running";
}

// Human-readable "1 hour ago" / "3 days ago".
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 2_592_000) return rtf.format(Math.round(diffSec / 86_400), "day");
  if (abs < 31_536_000) {
    return rtf.format(Math.round(diffSec / 2_592_000), "month");
  }
  return rtf.format(Math.round(diffSec / 31_536_000), "year");
}

// A single status pill: Failed / Running · N% / Ready / Queued.
function VideoStatusPill({ video }: { video: LibraryVideo }) {
  const base =
    "inline-flex items-center gap-1.5 rounded-md border-2 border-foreground px-2 py-0.5 text-xs font-bold text-foreground";
  if (isVideoFailed(video)) {
    return <span className={cn(base, "bg-vidura-coral")}>Failed</span>;
  }
  if (isVideoStillProcessing(video)) {
    return (
      <span className={cn(base, "bg-vidura-sun")}>
        <Loader2Icon className="size-3.5 animate-spin" />
        Running · {video.latestJob?.progress ?? 0}%
      </span>
    );
  }
  if (video.status === "ready") {
    return <span className={cn(base, "bg-vidura-mint")}>Ready</span>;
  }
  return <span className={cn(base, "bg-card")}>Queued</span>;
}

// Friendly display name for the model id that produced the translation.
function translationModelLabel(model: string | null): string | null {
  if (!model) return null;
  const value = model.toLowerCase();
  if (value.includes("deepseek")) return "DeepSeek";
  if (value.includes("gpt") || value.includes("openai")) return "OpenAI";
  if (value.includes("gemini")) return "Gemini";
  return model.split("/").pop() ?? model;
}

// Provenance + timing-quality badges for the watch page: where the transcript
// timestamps came from (YouTube's own captions vs Gemini audio ASR), which
// model translated the subtitles, and a sync-quality score computed from the
// timings themselves (overlaps, ordering, runtime coverage).
function SubtitleProvenanceBadges({ video }: { video: LibraryVideo }) {
  const quality = video.subtitleQuality;
  const source = video.transcriptSource ?? quality?.source ?? null;
  const model = translationModelLabel(video.translationModel);
  const translationCoverage = translationCoveragePercent(
    video.latestJob?.metadata ?? {},
  );
  if (!source && !quality && !model && translationCoverage === null) return null;

  const base =
    "inline-flex items-center gap-1.5 rounded-md border-2 border-foreground px-2 py-0.5 text-xs font-bold text-foreground";
  const sourceLabel = source === "ytdlp"
    ? "YouTube captions"
    : source === "gemini"
    ? "AI transcribed · Gemini"
    : source === "uploaded"
    ? "Uploaded transcript"
    : null;
  const qualityTone = quality
    ? quality.label === "excellent"
      ? "bg-vidura-mint"
      : quality.label === "good"
      ? "bg-vidura-sky"
      : quality.label === "fair"
      ? "bg-vidura-sun"
      : "bg-vidura-coral"
    : "bg-card";
  const qualityTitle = quality
    ? `${quality.metrics.segmentCount} lines · ${quality.metrics.overlapCount} overlaps` +
      (quality.metrics.coverageRatio !== null
        ? ` · covers ${Math.round(quality.metrics.coverageRatio * 100)}% of the video`
        : "")
    : undefined;
  const totalSegments = Number(video.latestJob?.metadata.total_segments ?? 0);
  const translatedSegments = Number(
    video.latestJob?.metadata.translated_segments ?? 0,
  );
  const translationTitle = translationCoverage === null
    ? undefined
    : `${translatedSegments} of ${totalSegments} subtitle lines translated`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {sourceLabel ? (
        <span
          className={cn(
            base,
            source === "ytdlp" ? "bg-vidura-mint" : "bg-vidura-sun",
          )}
          title={source === "ytdlp"
            ? "Timestamps come from YouTube's own caption track (frame-accurate)."
            : source === "gemini"
            ? "No caption track on YouTube — Gemini transcribed the audio (timing can drift a few seconds)."
            : "Transcript was supplied at import time."}
        >
          <CaptionsIcon className="size-3.5" />
          {sourceLabel}
        </span>
      ) : null}
      {quality ? (
        <span className={cn(base, qualityTone)} title={qualityTitle}>
          <BadgeCheckIcon className="size-3.5" />
          Timing {quality.score}%
        </span>
      ) : null}
      {translationCoverage !== null ? (
        <span
          className={cn(
            base,
            translationCoverage === 100 ? "bg-vidura-mint" : "bg-vidura-sun",
          )}
          title={translationTitle}
        >
          <BadgeCheckIcon className="size-3.5" />
          Translation {translationCoverage}%
        </span>
      ) : null}
      {model ? (
        <span className={cn(base, "bg-card")}>
          Translated by {model}
        </span>
      ) : null}
    </div>
  );
}

function InlineLoadingNotice({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-black text-foreground/65">
      <Loader2Icon className="size-4 shrink-0 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6">
      <StickerCard className="w-full max-w-sm">
        <CardContent className="flex items-center gap-3 p-5">
          <div className="size-5 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
          <p className="font-black">Loading Vidura...</p>
        </CardContent>
      </StickerCard>
    </main>
  );
}

function AuthScreen({
  onSignIn,
}: {
  onSignIn: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSignIn() {
    setSubmitting(true);
    setError("");

    try {
      await onSignIn();
      setSubmitting(false);
    } catch (signInError) {
      setError(
        signInError instanceof Error
          ? signInError.message
          : "Could not start Google sign in.",
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6">
      <StickerCard className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-lg border-2 border-foreground bg-vidura-sun shadow-[3px_3px_0_var(--vidura-ink)]">
              <BookOpenIcon />
            </div>
            <div>
              <CardTitle className="font-display text-4xl font-black">
                Vidura
              </CardTitle>
              <CardDescription>Sign in to save your lessons.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <Field data-invalid={Boolean(error)}>
              <FieldLabel>Google account</FieldLabel>
              <FieldDescription className="font-bold text-foreground/60">
                Continue with Google to save your video library and chats.
              </FieldDescription>
              {error ? (
                <FieldDescription className="font-bold text-destructive">
                  {error}
                </FieldDescription>
              ) : null}
            </Field>
            <CartoonButton disabled={submitting} onClick={handleSignIn} type="button">
              <span className="grid size-6 place-items-center rounded-full border-2 border-foreground bg-card font-black">
                G
              </span>
              {submitting ? "Opening Google..." : "Continue with Google"}
              <ChevronRightIcon data-icon="inline-end" />
            </CartoonButton>
            {import.meta.env.DEV ? <DevEmailAuth onError={setError} /> : null}
          </div>
        </CardContent>
      </StickerCard>
    </main>
  );
}

// Local-dev only: email/password sign-in so you can test without Google OAuth.
// Never rendered in production builds (import.meta.env.DEV is false there).
function DevEmailAuth({ onError }: { onError: (message: string) => void }) {
  const { signInWithEmail, signUpWithEmail } = useAuth();
  const [email, setEmail] = useState("dev@vidura.local");
  const [password, setPassword] = useState("devpassword123");
  const [busy, setBusy] = useState(false);

  async function run(mode: "in" | "up") {
    setBusy(true);
    onError("");
    try {
      if (mode === "up") {
        await signUpWithEmail(email, password, email.split("@")[0] ?? "Dev");
      } else {
        await signInWithEmail(email, password);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border-2 border-dashed border-foreground/40 p-3">
      <p className="text-xs font-bold uppercase text-foreground/50">
        Dev login (local only)
      </p>
      <Input
        className="h-10 border-2 border-foreground bg-card"
        onChange={(e) => setEmail(e.target.value)}
        placeholder="email"
        value={email}
      />
      <Input
        className="h-10 border-2 border-foreground bg-card"
        onChange={(e) => setPassword(e.target.value)}
        placeholder="password"
        type="password"
        value={password}
      />
      <div className="flex gap-2">
        <Button
          className="flex-1 border-2 border-foreground bg-card"
          disabled={busy}
          onClick={() => run("up")}
          type="button"
          variant="outline"
        >
          Sign up
        </Button>
        <Button
          className="flex-1 border-2 border-foreground bg-vidura-mint"
          disabled={busy}
          onClick={() => run("in")}
          type="button"
        >
          Sign in
        </Button>
      </div>
    </div>
  );
}

function TopBar() {
  const auth = useAuth();
  const location = useLocation();
  const selectedVideoId = useAppStore((state) => state.selectedVideoId);
  const currentView = viewFromPath(location.pathname);
  const title = {
    library: "Library",
    add: "Add video",
    watch: "Watch",
    chat: "Chat",
    settings: "Settings",
  }[currentView];

  return (
    <header className="mb-4 flex items-center justify-between gap-3 sm:mb-5 lg:hidden">
      <div className="min-w-0">
        <p className="truncate font-display text-3xl font-black leading-none tracking-normal">
          {title}
        </p>
        <p className="truncate text-sm font-medium text-foreground/55">
          Learn better, one video at a time.
        </p>
      </div>
      {currentView === "chat" ? (
        <ChatSessionsSheet
          trigger={
            <Button
              className="vidura-icon-button ml-auto shrink-0"
              size="icon-lg"
              variant="outline"
            >
              <HistoryIcon />
              <span className="sr-only">Chat history</span>
            </Button>
          }
        />
      ) : null}
      <Sheet>
        <SheetTrigger asChild>
          <Button className="vidura-icon-button shrink-0" size="icon-lg" variant="outline">
            <MenuIcon />
            <span className="sr-only">Open menu</span>
          </Button>
        </SheetTrigger>
        <SheetContent
          className="flex w-[min(100vw-1.5rem,18rem)] flex-col border-2 border-foreground bg-background p-0 sm:max-w-xs"
          side="left"
        >
          <SheetHeader className="border-b-2 border-foreground px-4 py-4">
            <div className="flex items-center gap-2.5 pr-8">
              <div className="grid size-11 place-items-center rounded-lg border-2 border-foreground bg-vidura-sun shadow-[3px_3px_0_var(--vidura-ink)]">
                <BookOpenIcon />
              </div>
              <div className="min-w-0">
                <SheetTitle className="truncate font-display text-3xl font-black">
                  Vidura
                </SheetTitle>
                <SheetDescription className="truncate font-semibold text-foreground/55">
                  Your playful Sinhala study companion.
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-4">
            {navItems.map(({ view, label, Icon }) => (
              <Button
                asChild
                className={cn(
                  "h-10 justify-start rounded-md border-2 border-transparent px-2 text-sm font-black",
                  currentView === view &&
                  "border-foreground bg-vidura-mint text-foreground shadow-[3px_3px_0_var(--vidura-ink)] hover:bg-vidura-mint"
                )}
                key={view}
                variant={currentView === view ? "secondary" : "ghost"}
              >
                <NavLink to={navPathFor(view, selectedVideoId)}>
                  <Icon data-icon="inline-start" />
                  {label}
                </NavLink>
              </Button>
            ))}
          </div>
          {auth.configured && auth.user ? (
            <SheetFooter className="border-t-2 border-foreground bg-card/60 px-4 py-4">
              <SidebarProfileFooter onSignOut={auth.signOut} user={auth.user} />
            </SheetFooter>
          ) : null}
        </SheetContent>
      </Sheet>
    </header>
  );
}

function getUserDisplayName(user: SessionUser | null) {
  if (!user) {
    return "Guest";
  }

  const metadata = user.user_metadata;

  if (typeof metadata?.full_name === "string" && metadata.full_name.trim()) {
    return metadata.full_name.trim();
  }

  if (typeof metadata?.name === "string" && metadata.name.trim()) {
    return metadata.name.trim();
  }

  return user.email?.split("@")[0] ?? "User";
}

function getUserInitials(user: SessionUser | null) {
  const displayName = getUserDisplayName(user);
  const parts = displayName.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }

  return displayName.slice(0, 2).toUpperCase();
}

function SidebarProfileFooter({
  user,
  onSignOut,
  className,
}: {
  user: SessionUser | null;
  onSignOut: () => Promise<void>;
  className?: string;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const displayName = getUserDisplayName(user);
  const email = user?.email ?? "Signed in";

  async function handleSignOut() {
    setSigningOut(true);

    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <div className="flex items-center gap-2.5 rounded-lg border-2 border-foreground bg-card p-2.5 shadow-[3px_3px_0_var(--vidura-ink)]">
        <Avatar className="size-9 shrink-0 border-2 border-foreground bg-vidura-purple">
          <AvatarFallback className="bg-transparent text-xs font-black text-foreground">
            {getUserInitials(user)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black leading-tight">{displayName}</p>
          <p className="truncate text-[0.68rem] font-semibold text-foreground/55">
            {email}
          </p>
        </div>
      </div>
      <Button
        className="h-9 w-full justify-start rounded-md border-2 border-foreground bg-card px-2.5 text-sm font-bold shadow-[2px_2px_0_var(--vidura-ink)] hover:bg-vidura-coral/15"
        disabled={signingOut}
        onClick={() => {
          void handleSignOut();
        }}
        size="sm"
        variant="outline"
      >
        <LogOutIcon data-icon="inline-start" />
        {signingOut ? "Signing out..." : "Sign out"}
      </Button>
    </div>
  );
}

function DesktopSidebar() {
  const auth = useAuth();
  const location = useLocation();
  const selectedVideoId = useAppStore((state) => state.selectedVideoId);
  const currentView = viewFromPath(location.pathname);

  return (
    <aside className="sticky top-0 hidden h-dvh w-[216px] shrink-0 border-r-2 border-foreground bg-background lg:block 2xl:w-[224px]">
      <div className="flex h-full flex-col px-4 py-5">
        <div className="shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="grid size-12 place-items-center rounded-lg border-2 border-foreground bg-vidura-sun shadow-[3px_3px_0_var(--vidura-ink)]">
              <BookOpenIcon />
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-display text-3xl font-black leading-none tracking-normal">
                Vidura
              </h1>
              <p className="truncate text-[0.72rem] font-semibold text-foreground/55">
                Sinhala video study
              </p>
            </div>
          </div>
        </div>
        <nav className="mt-5 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto py-1">
          {navItems.map(({ view, label, Icon }) => (
            <Button
              asChild
              className={cn(
                "h-9 justify-start rounded-md border-2 border-transparent px-2 text-sm font-black",
                currentView === view &&
                "border-foreground bg-vidura-mint text-foreground shadow-[3px_3px_0_var(--vidura-ink)] hover:bg-vidura-mint"
              )}
              key={view}
              variant={currentView === view ? "secondary" : "ghost"}
            >
              <NavLink to={navPathFor(view, selectedVideoId)}>
                <Icon data-icon="inline-start" />
                {label}
              </NavLink>
            </Button>
          ))}
        </nav>
        <div className="mt-auto flex shrink-0 flex-col gap-4 pt-4">
          <div className="rounded-lg border-2 border-foreground bg-card p-3 shadow-[3px_3px_0_var(--vidura-ink)]">
            <div className="mb-2 flex items-center gap-2">
              <div className="grid size-8 place-items-center rounded-md border-2 border-foreground bg-vidura-sun">
                <BadgeCheckIcon />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-black leading-none">Level 3</p>
                <p className="text-[0.68rem] font-bold text-foreground/55">
                  Study sync
                </p>
              </div>
            </div>
            <p className="text-xs font-semibold leading-snug text-foreground/65">
              Your library updates live.
            </p>
          </div>
          {auth.configured && auth.user ? (
            <>
              <Separator className="bg-foreground/15" />
              <SidebarProfileFooter onSignOut={auth.signOut} user={auth.user} />
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function MobileNav() {
  const location = useLocation();
  const selectedVideoId = useAppStore((state) => state.selectedVideoId);
  const currentView = viewFromPath(location.pathname);

  return (
    <nav className="fixed inset-x-3 bottom-3 z-40 rounded-lg border-2 border-foreground bg-card px-2 py-1.5 shadow-[4px_4px_0_var(--vidura-ink)] sm:inset-x-4 sm:bottom-4 sm:px-2.5 lg:hidden">
      <div className="grid grid-cols-5 gap-1 sm:gap-1.5">
        {navItems.map(({ view, label, Icon }) => (
          <Button
            asChild
            className={cn(
              "h-12 flex-col gap-0.5 rounded-md px-1 text-[0.66rem] font-bold sm:h-13 sm:text-[0.7rem]",
              currentView === view &&
              "border-2 border-foreground bg-vidura-mint text-foreground hover:bg-vidura-mint"
            )}
            key={view}
            variant="ghost"
          >
            <NavLink className="flex flex-col items-center justify-center" to={navPathFor(view, selectedVideoId)}>
              <Icon className="size-4 sm:size-4.5" data-icon="inline-start" />
              <span className="truncate">{label}</span>
            </NavLink>
          </Button>
        ))}
      </div>
    </nav>
  );
}

function LibraryScreen({
  videos,
  isPending,
  error,
}: {
  videos: LibraryVideo[];
  isPending: boolean;
  error: Error | null;
}) {
  const [category, setCategory] = useState("All");
  const [pendingDeleteVideoId, setPendingDeleteVideoId] = useState<
    string | null
  >(null);
  const selectVideo = useAppStore((state) => state.selectVideo);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deleteVideoMutation = useMutation({
    mutationFn: deleteVideo,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: videoQueryKeys.all });
      setPendingDeleteVideoId(null);
    },
  });
  const pendingDeleteVideo = videos.find(
    (video) => video.id === pendingDeleteVideoId,
  );
  const filteredVideos = useMemo(
    () =>
      category === "All"
        ? videos
        : videos.filter((video) => video.category === category),
    [category, videos]
  );
  const categoryOptions = useMemo(
    () => ["All", ...Array.from(new Set(videos.map((video) => video.category)))],
    [videos],
  );
  const learningStats = useMemo(
    () => [
      { label: "Videos processed", value: videos.length.toString() },
      {
        label: "Ready",
        value: videos.filter((video) => video.status === "ready").length.toString(),
      },
      {
        label: "Processing",
        value: videos.filter((video) => video.status !== "ready").length.toString(),
      },
    ],
    [videos],
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="hidden items-end justify-between gap-4 lg:flex">
        <div>
          <h2 className="font-display text-5xl font-black tracking-normal">
            Library
          </h2>
          <p className="text-base font-medium text-foreground/60">
            Pick up where your translated lessons stopped.
          </p>
        </div>
        <SearchTools />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ToggleGroup
          className="justify-start overflow-x-auto"
          onValueChange={(value) => value && setCategory(value)}
          type="single"
          value={category}
        >
          {categoryOptions.map((item) => (
            <ToggleGroupItem
              className="rounded-md border-2 border-foreground bg-card data-[state=on]:bg-vidura-mint"
              key={item}
              value={item}
            >
              {item}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="lg:hidden">
          <SearchTools compact />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-3">
          {isPending ? (
            <StickerCard>
              <CardContent className="p-4 font-black">Loading videos...</CardContent>
            </StickerCard>
          ) : null}
          {error ? (
            <StickerCard className="bg-vidura-coral">
              <CardContent className="p-4 font-black">
                Could not load library: {error.message}
              </CardContent>
            </StickerCard>
          ) : null}
          {!isPending && !error && filteredVideos.length === 0 ? (
            <StickerCard>
              <CardContent className="p-5">
                <h3 className="font-display text-3xl font-black">No videos yet</h3>
                <p className="mt-1 text-sm font-semibold text-foreground/60">
                  Add a YouTube link to start your first Sinhala study session.
                </p>
              </CardContent>
            </StickerCard>
          ) : null}
          {filteredVideos.map((video) => (
            <StickerCard
              className="animate-vidura-fade-in-up cursor-pointer transition-transform hover:-translate-y-0.5"
              key={video.id}
              onClick={() => {
                selectVideo(video.id);
                navigate(`/watch/${video.id}`);
              }}
            >
              <CardContent className="grid gap-3 p-3 sm:grid-cols-[164px_1fr] sm:items-center">
                <div
                  className={cn(
                    "relative flex aspect-video items-center justify-center overflow-hidden rounded-md border-2 border-foreground text-foreground",
                    video.accent
                  )}
                >
                  {video.thumbnailUrl ? (
                    <img
                      alt=""
                      className="size-full object-cover"
                      src={video.thumbnailUrl}
                    />
                  ) : (
                    <video.Icon className="size-12" />
                  )}
                  <Badge className="absolute bottom-2 right-2 border border-foreground bg-card text-foreground">
                    {video.duration}
                  </Badge>
                </div>
                <div className="flex min-w-0 flex-col gap-2.5">
                  <div>
                    <h3 className="line-clamp-2 text-base font-black leading-tight sm:text-lg">
                      {video.title}
                    </h3>
                    <p className="mt-1 truncate text-sm font-medium text-foreground/60">
                      {video.channel}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      <VideoStatusPill video={video} />
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-foreground/50">
                        <ClockIcon className="size-3.5" />
                        {formatRelativeTime(video.createdAt)}
                      </span>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          onClick={(event) => event.stopPropagation()}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <MoreHorizontalIcon />
                          <span className="sr-only">Open video menu</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            onSelect={() => {
                              selectVideo(video.id);
                              navigate(`/watch/${video.id}`);
                            }}
                          >
                            Open video
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onSelect={() => setPendingDeleteVideoId(video.id)}
                          >
                            Delete video
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardContent>
            </StickerCard>
          ))}
        </div>
        <aside className="flex flex-col gap-4">
          <StickerPanel title="Keep learning">
            <div className="grid grid-cols-3 gap-2 xl:grid-cols-1">
              {learningStats.map((stat) => (
                <div
                  className="rounded-md border-2 border-foreground bg-vidura-cream p-3"
                  key={stat.label}
                >
                  <p className="font-display text-2xl font-black">
                    {stat.value}
                  </p>
                  <p className="text-xs font-bold text-foreground/60">
                    {stat.label}
                  </p>
                </div>
              ))}
            </div>
          </StickerPanel>
          <MascotBubble tone="sky">
            Add a difficult video, translate it once, and keep asking questions
            as you study.
          </MascotBubble>
        </aside>
      </div>
      <ConfirmDialog
        busy={deleteVideoMutation.isPending}
        description={pendingDeleteVideo
          ? `"${pendingDeleteVideo.title}" and its transcript, subtitles, notes, and chats will be permanently deleted.`
          : undefined}
        onCancel={() => setPendingDeleteVideoId(null)}
        onConfirm={() => {
          if (pendingDeleteVideoId) {
            deleteVideoMutation.mutate(pendingDeleteVideoId);
          }
        }}
        open={pendingDeleteVideoId !== null}
        title="Delete this video?"
      />
    </section>
  );
}

function SearchTools({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <InputGroup className={cn("border-2 border-foreground bg-card", compact && "h-10")}>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search videos..." />
      </InputGroup>
      <Button className="vidura-icon-button" size="icon-lg" variant="outline">
        <FilterIcon />
        <span className="sr-only">Filter videos</span>
      </Button>
    </div>
  );
}

function AddVideoScreen() {
  const transcriptInputRef = useRef<HTMLInputElement>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStep, setSubmitStep] = useState("");
  const [transcriptFileName, setTranscriptFileName] = useState("");
  const [transcriptSegments, setTranscriptSegmentsState] = useState<
    TranscriptSegment[]
  >([]);
  const [transcriptError, setTranscriptError] = useState("");
  const setSelectedVideoId = useAppStore((state) => state.setSelectedVideoId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleStartProcessing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsedUrl = parseYouTubeUrl(youtubeUrl);

    if (!parsedUrl) {
      setUrlError("Paste a valid YouTube video, Shorts, embed, or youtu.be link.");
      return;
    }

    setIsSubmitting(true);
    setSubmitStep("Preparing video...");

    try {
      // The backend fetches the transcript and metadata from YouTube during
      // processing; we only pass segments when the user uploaded a file.
      setSubmitStep("Creating processing job...");
      const response = await createVideoJob({
        youtubeUrl: parsedUrl.canonicalUrl,
        targetLanguage: "si-LK",
        segments: transcriptSegments,
      });

      setSelectedVideoId(response.video.id);
      await queryClient.invalidateQueries({ queryKey: videoQueryKeys.all });

      setUrlError("");
      navigate(`/processing/${response.video.id}`);
    } catch (createError) {
      setUrlError(
        createError instanceof Error
          ? createError.message
          : "Could not create the video job.",
      );
    } finally {
      setIsSubmitting(false);
      setSubmitStep("");
    }
  }

  async function handleTranscriptFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const parsedTranscript = await parseTranscriptFile(file);

      if (parsedTranscript.length === 0) {
        throw new Error("No transcript lines were found in that file.");
      }

      setTranscriptSegmentsState(parsedTranscript);
      setTranscriptFileName(file.name);
      setTranscriptError("");
    } catch (parseError) {
      setTranscriptSegmentsState([]);
      setTranscriptFileName("");
      setTranscriptError(
        parseError instanceof Error
          ? parseError.message
          : "Could not read that transcript file.",
      );
    } finally {
      event.target.value = "";
    }
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      setYoutubeUrl(text);
      setUrlError("");
    } catch {
      setUrlError("Clipboard access was not available. Paste the link manually.");
    }
  }

  return (
    <section className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[1fr_360px]">
      <StickerPanel
        description="Paste a YouTube link. If captions are missing, import a transcript file."
        title="Add video"
      >
        <form onSubmit={handleStartProcessing}>
          <FieldGroup>
            <Field data-invalid={Boolean(urlError)}>
              <FieldLabel htmlFor="youtube-url">YouTube link</FieldLabel>
              <InputGroup className="h-12 border-2 border-foreground bg-card">
                <InputGroupInput
                  aria-invalid={Boolean(urlError)}
                  id="youtube-url"
                  onChange={(event) => {
                    setYoutubeUrl(event.target.value);
                    if (urlError) {
                      setUrlError("");
                    }
                  }}
                  placeholder="Paste YouTube URL here..."
                  value={youtubeUrl}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton onClick={pasteFromClipboard} size="icon-sm">
                    <LinkIcon />
                    <span className="sr-only">Paste link</span>
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {urlError ? (
                <FieldDescription className="font-bold text-destructive">
                  {urlError}
                </FieldDescription>
              ) : (
                <FieldDescription>
                  Supports `youtube.com/watch`, `youtu.be`, Shorts, and embed
                  links.
                </FieldDescription>
              )}
            </Field>
            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-xs font-black uppercase text-foreground/50">
                or
              </span>
              <Separator className="flex-1" />
            </div>
            <Field>
              <FieldLabel>Import transcript optional</FieldLabel>
              <div className="rounded-lg border-2 border-dashed border-foreground bg-vidura-cream p-5 text-center">
                <UploadIcon className="mx-auto mb-3 size-8" />
                <FieldTitle className="mx-auto">
                  Drop `.srt`, `.vtt`, or `.txt`
                </FieldTitle>
                <FieldDescription className="mx-auto max-w-sm text-center">
                  {transcriptSegments.length > 0
                    ? `Loaded ${transcriptSegments.length} lines from ${transcriptFileName}.`
                    : "Manual transcripts keep the workflow available when a video has no public captions."}
                </FieldDescription>
                <input
                  accept=".srt,.vtt,.txt"
                  className="sr-only"
                  onChange={handleTranscriptFileChange}
                  ref={transcriptInputRef}
                  type="file"
                />
                <Button
                  className="mt-4 border-2 border-foreground"
                  onClick={() => transcriptInputRef.current?.click()}
                  type="button"
                  variant="outline"
                >
                  {transcriptSegments.length > 0 ? "Replace file" : "Choose file"}
                </Button>
              </div>
              {transcriptError ? (
                <FieldDescription className="font-bold text-destructive">
                  {transcriptError}
                </FieldDescription>
              ) : null}
            </Field>
            <MascotBubble tone="sun">
              We will fetch the transcript if available, translate it to Sinhala,
              and generate synced subtitles.
            </MascotBubble>
            <CartoonButton disabled={isSubmitting} type="submit">
              {isSubmitting ? submitStep || "Creating job..." : "Start processing"}
              <ChevronRightIcon data-icon="inline-end" />
            </CartoonButton>
          </FieldGroup>
        </form>
      </StickerPanel>

      <div className="flex flex-col gap-4">
        <StickerPanel title="How it works">
          <div className="flex flex-col gap-3">
            {[
              "Fetch or import transcript",
              "Translate with context",
              "Sync Sinhala subtitles",
              "Save to your library",
            ].map((item, index) => (
              <div className="flex items-center gap-3" key={item}>
                <div className="grid size-8 place-items-center rounded-md border-2 border-foreground bg-vidura-mint font-black">
                  {index + 1}
                </div>
                <p className="font-bold">{item}</p>
              </div>
            ))}
          </div>
        </StickerPanel>
        <StickerPanel title="Connection">
          <Badge
            className={cn(
              "w-fit border-2 border-foreground",
              isApiConfigured ? "bg-vidura-mint" : "bg-vidura-sun"
            )}
          >
            {isApiConfigured ? "Connected to Vidura API" : "API not configured"}
          </Badge>
          <p className="mt-3 text-sm font-medium text-foreground/65">
            If a video can't fetch its transcript automatically, import a
            transcript file above and it will be translated the same way.
          </p>
        </StickerPanel>
      </div>
    </section>
  );
}

function ProcessingRoute() {
  const { videoId } = useParams();
  const navigate = useNavigate();

  return (
    <ProcessingScreen
      onOpenWatch={() => navigate(videoId ? `/watch/${videoId}` : "/watch")}
      videoId={videoId ?? null}
    />
  );
}

function ProcessingScreen({
  onOpenWatch,
  videoId,
}: {
  onOpenWatch: () => void;
  videoId: string | null;
}) {
  const videosQuery = useLibraryVideos(Boolean(videoId));
  const video = videosQuery.data?.find((item) => item.id === videoId) ?? null;
  const job = video?.latestJob ?? null;
  const stage = typeof job?.metadata.stage === "string"
    ? job.metadata.stage
    : job?.status ?? "queued";
  const totalSegments = Number(job?.metadata.total_segments ?? 0);
  const translatedSegments = Number(job?.metadata.translated_segments ?? 0);
  const currentSegmentText =
    typeof job?.metadata.current_segment_text === "string"
      ? job.metadata.current_segment_text
      : null;

  return (
    <section className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[1fr_340px]">
      <StickerPanel
        description={video?.title ?? "Waiting for the new video job"}
        title="Processing"
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-full border-2 border-foreground bg-vidura-sun font-black">
                {job?.status === "ready" ? <CheckIcon /> : <ClockIcon />}
              </div>
              <div className="flex-1">
                <p className="font-black">{titleCase(stage.replaceAll("_", " "))}</p>
                <Progress
                  className="mt-2 h-3 border border-foreground"
                  value={job?.progress ?? 0}
                />
              </div>
              <Badge className="border-2 border-foreground bg-vidura-sun text-foreground">
                {job?.progress ?? 0}%
              </Badge>
            </div>
            {totalSegments > 0 ? (
              <StickerCard className="bg-vidura-cream">
                <CardContent className="p-4">
                  <p className="font-black">
                    Translating {translatedSegments} of {totalSegments} segments
                  </p>
                  {currentSegmentText ? (
                    <p className="mt-2 text-sm font-semibold text-foreground/65">
                      Current: {currentSegmentText}
                    </p>
                  ) : null}
                </CardContent>
              </StickerCard>
            ) : null}
            {job?.errorMessage ? (
              <StickerCard className="bg-vidura-coral">
                <CardContent className="p-4 text-sm font-black">
                  {job.errorMessage}
                </CardContent>
              </StickerCard>
            ) : null}
          </div>
          <StickerCard className="bg-vidura-sky">
            <CardContent className="flex items-center gap-3 p-4">
              <BellIcon className="size-8" />
              <p className="text-sm font-bold">
                You will get a notification when it is ready.
              </p>
            </CardContent>
          </StickerCard>
          <CartoonButton onClick={onOpenWatch}>
            Open watch screen
            <CirclePlayIcon data-icon="inline-end" />
          </CartoonButton>
          <Button asChild className="border-2 border-foreground" variant="outline">
            <NavLink to="/library">
              Send to background
              <HomeIcon data-icon="inline-end" />
            </NavLink>
          </Button>
        </div>
      </StickerPanel>
      <MascotBubble tone="mint">
        Long videos will run as background jobs so mobile users can leave this
        screen and come back later.
      </MascotBubble>
    </section>
  );
}

function SubtitleCaption({
  activeSubtitle,
  subtitlesStillLoading,
  failed = false,
  subtitleOpacity,
  subtitleSize,
  subtitleTextColor,
  subtitleBgColor,
  subtitlePosition = 6,
  variant,
}: {
  activeSubtitle: TranscriptSegment | null;
  subtitlesStillLoading: boolean;
  failed?: boolean;
  subtitleOpacity: number;
  subtitleSize: number;
  subtitleTextColor: string;
  subtitleBgColor: string;
  subtitlePosition?: number;
  variant: SubtitlePlacement;
}) {
  const content = activeSubtitle?.sinhala ? (
    activeSubtitle.sinhala
  ) : failed ? (
    "Subtitles couldn't be generated for this video."
  ) : subtitlesStillLoading ? (
    <span className="inline-flex items-center justify-center gap-2">
      <Loader2Icon className="size-4 shrink-0 animate-spin" />
      Sinhala subtitles are loading...
    </span>
  ) : (
    // A silent stretch between lines is just silence — show nothing.
    null
  );

  if (content === null) return null;

  if (variant === "overlay") {
    return (
      <div
        className="pointer-events-none absolute inset-x-0 z-30 mx-auto w-fit max-w-[min(90%,760px)] rounded-md border-2 border-white/80 px-2.5 py-1.5 text-center font-black leading-tight shadow-[4px_4px_0_#000] sm:px-3 sm:py-2 sm:leading-snug"
        style={{
          bottom: `${subtitlePosition}%`,
          backgroundColor:
            `rgb(${hexToRgbChannels(subtitleBgColor)} / ${subtitleOpacity / 100})`,
          color: subtitleTextColor,
          display: "-webkit-box",
          fontSize: `clamp(14px, 3.4vw, ${subtitleSize}px)`,
          maxHeight: "7em",
          overflow: "hidden",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 3,
        }}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      className="rounded-md border-2 border-foreground px-3 py-2.5 text-center font-black leading-snug shadow-[3px_3px_0_var(--vidura-ink)]"
      style={{
        backgroundColor:
          `rgb(${hexToRgbChannels(subtitleBgColor)} / ${subtitleOpacity / 100})`,
        color: subtitleTextColor,
        fontSize: `clamp(14px, 3.4vw, ${subtitleSize}px)`,
      }}
    >
      {content}
    </div>
  );
}

// VLC-style subtitle controls that live on the player, so they also work in
// fullscreen. Rendered inside the video container.
function SubtitleSettingsPanel({ onClose }: { onClose: () => void }) {
  const subtitleEnabled = useAppStore((s) => s.subtitleEnabled);
  const setSubtitleEnabled = useAppStore((s) => s.setSubtitleEnabled);
  const subtitlePlacement = useAppStore((s) => s.subtitlePlacement);
  const setSubtitlePlacement = useAppStore((s) => s.setSubtitlePlacement);
  const subtitleSize = useAppStore((s) => s.subtitleSize);
  const setSubtitleSize = useAppStore((s) => s.setSubtitleSize);
  const subtitleOpacity = useAppStore((s) => s.subtitleOpacity);
  const setSubtitleOpacity = useAppStore((s) => s.setSubtitleOpacity);
  const subtitleTextColor = useAppStore((s) => s.subtitleTextColor);
  const setSubtitleTextColor = useAppStore((s) => s.setSubtitleTextColor);
  const subtitleBgColor = useAppStore((s) => s.subtitleBgColor);
  const setSubtitleBgColor = useAppStore((s) => s.setSubtitleBgColor);
  const subtitlePosition = useAppStore((s) => s.subtitlePosition);
  const setSubtitlePosition = useAppStore((s) => s.setSubtitlePosition);

  return (
    // Full-viewport modal. Kept as a descendant of the player container (rather
    // than a portalled Dialog) with position:fixed, so it covers the viewport
    // normally AND stays visible when the container is in fullscreen.
    <div className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button
        aria-label="Close subtitle settings"
        className="absolute inset-0 cursor-default bg-black/60"
        onClick={onClose}
        type="button"
      />
      <div className="relative flex max-h-[85vh] w-[min(92vw,360px)] flex-col rounded-lg border-2 border-white/25 bg-black/90 text-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/15 px-4 py-3">
          <p className="text-sm font-black">Subtitle settings</p>
          <div className="flex items-center gap-2">
            <Switch
              checked={subtitleEnabled}
              onCheckedChange={setSubtitleEnabled}
            />
            <button
              aria-label="Close subtitle settings"
              className="grid size-7 place-items-center rounded-md hover:bg-white/15"
              onClick={onClose}
              type="button"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        <ScrollArea className="max-h-[60vh]">
          <div className="px-4 pb-4">
            <SubtitlePanelRow label="Position">
              <div className="flex gap-1.5">
                {(["overlay", "below"] as const).map((placement) => (
                  <button
                    className={cn(
                      "flex-1 rounded-md border border-white/25 px-2 py-1.5 text-xs font-bold",
                      subtitlePlacement === placement
                        ? "bg-vidura-mint text-black"
                        : "bg-white/5 hover:bg-white/10",
                    )}
                    key={placement}
                    onClick={() => setSubtitlePlacement(placement)}
                    type="button"
                  >
                    {placement === "overlay" ? "On video" : "Below video"}
                  </button>
                ))}
              </div>
            </SubtitlePanelRow>

            {subtitlePlacement === "overlay" ? (
              <SubtitlePanelRow
                label={`Vertical position · ${subtitlePosition}% from bottom`}
              >
                <Slider
                  max={45}
                  min={0}
                  onValueChange={([value]) => setSubtitlePosition(value)}
                  step={1}
                  value={[subtitlePosition]}
                />
              </SubtitlePanelRow>
            ) : null}

            <SubtitlePanelRow label={`Font size · ${subtitleSize}px`}>
              <Slider
                max={44}
                min={14}
                onValueChange={([value]) => setSubtitleSize(value)}
                step={1}
                value={[subtitleSize]}
              />
            </SubtitlePanelRow>

            <SubtitlePanelRow label={`Background opacity · ${subtitleOpacity}%`}>
              <Slider
                max={100}
                min={0}
                onValueChange={([value]) => setSubtitleOpacity(value)}
                step={1}
                value={[subtitleOpacity]}
              />
            </SubtitlePanelRow>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <SubtitleColorField
                label="Text"
                onChange={setSubtitleTextColor}
                value={subtitleTextColor}
              />
              <SubtitleColorField
                label="Background"
                onChange={setSubtitleBgColor}
                value={subtitleBgColor}
              />
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function SubtitlePanelRow(
  { label, children }: { label: string; children: ReactNode },
) {
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-bold text-white/70">{label}</p>
      {children}
    </div>
  );
}

function SubtitleColorField(
  { label, value, onChange }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
  },
) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-bold text-white/70">{label}</span>
      <span className="flex items-center gap-2 rounded-md border border-white/25 bg-white/5 px-1.5 py-1">
        <input
          className="size-7 cursor-pointer rounded border-0 bg-transparent p-0"
          onChange={(event) => onChange(event.target.value)}
          type="color"
          value={value}
        />
        <span className="font-mono text-xs uppercase">{value}</span>
      </span>
    </label>
  );
}

function WatchScreen({ videos }: { videos: LibraryVideo[] }) {
  const subtitleEnabled = useAppStore((state) => state.subtitleEnabled);
  const subtitlePlacement = useAppStore((state) => state.subtitlePlacement);
  const subtitleSize = useAppStore((state) => state.subtitleSize);
  const subtitleOpacity = useAppStore((state) => state.subtitleOpacity);
  const subtitleTextColor = useAppStore((state) => state.subtitleTextColor);
  const subtitleBgColor = useAppStore((state) => state.subtitleBgColor);
  const subtitlePosition = useAppStore((state) => state.subtitlePosition);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const [isImmersive, setIsImmersive] = useState(false);
  const [subtitlePanelOpen, setSubtitlePanelOpen] = useState(false);
  const [playbackTime, setPlaybackTime] = useState<{
    videoId: string | null;
    milliseconds: number;
  }>({ videoId: null, milliseconds: 0 });
  const { videoId } = useParams();
  const navigate = useNavigate();
  const storedSelectedVideoId = useAppStore((state) => state.selectedVideoId);
  const setSelectedVideoId = useAppStore((state) => state.setSelectedVideoId);
  const selectedVideoId = videoId ?? storedSelectedVideoId;
  const selectedVideo =
    videos.find((video) => video.id === selectedVideoId) ?? videos[0] ?? null;
  const transcriptQuery = useQuery({
    queryKey: videoQueryKeys.transcript(selectedVideo?.id ?? null),
    queryFn: () => fetchVideoTranscript(selectedVideo?.id ?? null),
    enabled: Boolean(selectedVideo),
    // Fallback only — realtime pushes transcript updates as they land.
    refetchInterval: isVideoStillProcessing(selectedVideo) ? 5_000 : false,
  });
  const selectedTranscript = transcriptQuery.data ?? [];
  const videoFailed = isVideoFailed(selectedVideo);
  const subtitlesStillLoading = !videoFailed &&
    (transcriptQuery.isPending || isVideoStillProcessing(selectedVideo));
  const showOverlaySubtitles = isImmersive || subtitlePlacement === "overlay";
  const showBelowSubtitles = !isImmersive && subtitlePlacement === "below";
  const currentPlaybackMs = playbackTime.videoId === selectedVideo?.id
    ? playbackTime.milliseconds
    : 0;
  const activeSubtitle = findActiveTranscriptSegment(
    selectedTranscript,
    currentPlaybackMs,
  );
  const youtubeVideoId = isYouTubeVideoId(selectedVideo?.youtubeVideoId)
    ? selectedVideo.youtubeVideoId
    : null;
  const videoWatchUrl = selectedVideo?.youtubeUrl ??
    (youtubeVideoId ? buildYouTubeWatchUrl(youtubeVideoId) : null);
  const playbackMsRef = useRef(0);
  const getCurrentTimeMs = useCallback(() => playbackMsRef.current, []);
  const handlePlaybackTimeChange = useCallback((milliseconds: number) => {
    playbackMsRef.current = milliseconds;
    setPlaybackTime((currentTime) => {
      if (
        currentTime.videoId === selectedVideo?.id &&
        Math.abs(currentTime.milliseconds - milliseconds) < 250
      ) {
        return currentTime;
      }

      return {
        videoId: selectedVideo?.id ?? null,
        milliseconds,
      };
    });
  }, [selectedVideo?.id]);

  useEffect(() => {
    function handleFullscreenChange() {
      setIsImmersive(document.fullscreenElement === videoContainerRef.current);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  async function toggleImmersivePlayback() {
    const container = videoContainerRef.current;

    if (!container) {
      return;
    }

    if (isImmersive) {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }

      setIsImmersive(false);
      return;
    }

    try {
      await container.requestFullscreen();
      setIsImmersive(true);
    } catch {
      setIsImmersive(true);
    }
  }

  useEffect(() => {
    if (selectedVideo?.id && selectedVideo.id !== storedSelectedVideoId) {
      setSelectedVideoId(selectedVideo.id);
    }
  }, [selectedVideo?.id, setSelectedVideoId, storedSelectedVideoId]);

  if (!selectedVideo) {
    return (
      <StickerCard>
        <CardContent className="p-5">
          <h2 className="font-display text-3xl font-black">No video selected</h2>
          <p className="mt-1 text-sm font-semibold text-foreground/60">
            Add a video or open one from the library.
          </p>
        </CardContent>
      </StickerCard>
    );
  }

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="hidden items-center justify-between gap-3 lg:flex">
          <div>
            <h2 className="font-display text-4xl font-black tracking-normal">
              Watch
            </h2>
            <p className="font-medium text-foreground/60">
              {selectedVideo.title}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button className="border-2 border-foreground" variant="outline">
              <DownloadIcon data-icon="inline-start" />
              Subtitles
            </Button>
            <Button
              className="border-2 border-foreground bg-vidura-mint text-foreground"
              onClick={() => navigate("/settings")}
              variant="secondary"
            >
              <SettingsIcon data-icon="inline-start" />
              SI subtitles
            </Button>
          </div>
        </div>
        <div className="overflow-visible rounded-lg border-2 border-foreground bg-vidura-ink shadow-[5px_5px_0_var(--vidura-shadow)]">
          <div
            className={cn(
              "relative bg-vidura-ink",
              isImmersive
                ? "fixed inset-0 z-50 flex h-dvh w-dvw items-center justify-center bg-black"
                : "aspect-video rounded-lg",
            )}
            ref={videoContainerRef}
          >
            {youtubeVideoId ? (
              <YouTubePlayerFrame
                key={youtubeVideoId}
                onTimeChange={handlePlaybackTimeChange}
                title={selectedVideo.title}
                videoId={youtubeVideoId}
                watchUrl={videoWatchUrl}
              />
            ) : (
              <>
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_30%,#8b7cf6_0_9%,transparent_10%),radial-gradient(circle_at_70%_35%,#ffcf4a_0_5%,transparent_6%),radial-gradient(circle_at_50%_75%,#4ecdc4_0_7%,transparent_8%)]" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="grid size-28 place-items-center rounded-full border-2 border-white bg-vidura-purple text-white shadow-[6px_6px_0_#ff6b5a] sm:size-40">
                    <CirclePlayIcon className="size-16 sm:size-24" />
                  </div>
                </div>
              </>
            )}
            {youtubeVideoId ? (
              <div className="pointer-events-auto absolute top-2 right-2 z-40 flex items-center gap-2">
                <Button
                  aria-label="Subtitle settings"
                  className="border-2 border-white/80 bg-black/55 text-white hover:bg-black/75"
                  onClick={() => setSubtitlePanelOpen((open) => !open)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <SettingsIcon />
                </Button>
                <Button
                  aria-label={isImmersive ? "Exit fullscreen" : "Enter fullscreen"}
                  className="border-2 border-white/80 bg-black/55 text-white hover:bg-black/75"
                  onClick={() => {
                    void toggleImmersivePlayback();
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  {isImmersive ? <Minimize2Icon /> : <Maximize2Icon />}
                </Button>
              </div>
            ) : null}
            {youtubeVideoId && subtitlePanelOpen ? (
              <SubtitleSettingsPanel
                onClose={() => setSubtitlePanelOpen(false)}
              />
            ) : null}
            {subtitleEnabled && showOverlaySubtitles ? (
              <SubtitleCaption
                activeSubtitle={activeSubtitle}
                failed={videoFailed}
                subtitleBgColor={subtitleBgColor}
                subtitleOpacity={subtitleOpacity}
                subtitlePosition={subtitlePosition}
                subtitleSize={subtitleSize}
                subtitleTextColor={subtitleTextColor}
                subtitlesStillLoading={subtitlesStillLoading}
                variant="overlay"
              />
            ) : null}
            {!youtubeVideoId ? (
              <div className="absolute inset-x-4 bottom-4 flex items-center gap-3 text-white">
                <CirclePlayIcon className="size-5" />
                <div className="h-2 flex-1 rounded-full bg-white/25">
                  <div className="h-2 w-[32%] rounded-full bg-vidura-coral" />
                </div>
                <span className="text-xs font-black">4:12 / 22:47</span>
              </div>
            ) : null}
          </div>
        </div>
        {subtitleEnabled && showBelowSubtitles ? (
          <SubtitleCaption
            activeSubtitle={activeSubtitle}
            failed={videoFailed}
            subtitleBgColor={subtitleBgColor}
            subtitleOpacity={subtitleOpacity}
            subtitleSize={subtitleSize}
            subtitleTextColor={subtitleTextColor}
            subtitlesStillLoading={subtitlesStillLoading}
            variant="below"
          />
        ) : null}
        <SubtitleProvenanceBadges video={selectedVideo} />
        <div className="grid gap-4 xl:hidden">
          <TranscriptPanel
            activeSegmentId={activeSubtitle?.id ?? null}
            failed={videoFailed}
            errorMessage={selectedVideo.latestJob?.errorMessage ?? null}
            isProcessing={isVideoStillProcessing(selectedVideo)}
            videoId={selectedVideo.id}
          />
          <NotesPanel
            getCurrentTimeMs={getCurrentTimeMs}
            videoId={selectedVideo.id}
          />
        </div>
        <div className="hidden flex-col gap-4 xl:flex">
          <TranscriptPanel
            activeSegmentId={activeSubtitle?.id ?? null}
            failed={videoFailed}
            errorMessage={selectedVideo.latestJob?.errorMessage ?? null}
            isProcessing={isVideoStillProcessing(selectedVideo)}
            videoId={selectedVideo.id}
          />
          <NotesPanel
            getCurrentTimeMs={getCurrentTimeMs}
            videoId={selectedVideo.id}
          />
        </div>
      </div>
      <aside className="hidden min-h-0 flex-col gap-4 xl:flex">
        <ChatPanel videoId={selectedVideo.id} />
        <VideoInfoPanel video={selectedVideo} />
      </aside>
      <FloatingChatButton videoId={selectedVideo.id} />
    </section>
  );
}

function findActiveTranscriptSegment(
  segments: TranscriptSegment[],
  playbackMs: number,
) {
  if (segments.length === 0) {
    return null;
  }

  const activeSegment = segments.find(
    (segment) => {
      if (!hasSegmentTiming(segment)) {
        return false;
      }

      return playbackMs >= segment.startMs - 500 &&
        playbackMs < segment.endMs + 250;
    },
  );

  if (activeSegment) {
    return activeSegment;
  }

  const firstTimedSegment = segments.find(hasSegmentTiming);

  if (!firstTimedSegment || playbackMs < firstTimedSegment.startMs) {
    return null;
  }

  return null;
}

function hasSegmentTiming(
  segment: TranscriptSegment,
): segment is TranscriptSegment & { startMs: number; endMs: number } {
  return typeof segment.startMs === "number" &&
    typeof segment.endMs === "number";
}

function YouTubePlayerFrame({
  onTimeChange,
  title,
  videoId,
  watchUrl,
}: {
  onTimeChange: (milliseconds: number) => void;
  title: string;
  videoId: string;
  watchUrl: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const onTimeChangeRef = useRef(onTimeChange);
  const lastReportedTimeRef = useRef(-1);
  const [playerError, setPlayerError] = useState<number | null>(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [isTouchPlayback, setIsTouchPlayback] = useState(false);
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    onTimeChangeRef.current = onTimeChange;
  }, [onTimeChange]);

  useEffect(() => {
    function updateTouchPlayback() {
      setIsTouchPlayback(
        window.matchMedia("(pointer: coarse)").matches ||
        window.matchMedia("(max-width: 1023px)").matches,
      );
    }

    updateTouchPlayback();
    window.addEventListener("resize", updateTouchPlayback);

    return () => {
      window.removeEventListener("resize", updateTouchPlayback);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeInterval: ReturnType<typeof window.setInterval> | null = null;
    const startTimePolling = () => {
      if (timeInterval) {
        return;
      }

      timeInterval = window.setInterval(() => {
        const player = playerRef.current;

        if (!player || typeof player.getCurrentTime !== "function") {
          return;
        }

        const playerState = typeof player.getPlayerState === "function"
          ? player.getPlayerState()
          : null;

        if (playerState === 1 || playerState === 3) {
          setHasStartedPlayback(true);
          setIsPlaying(true);
        } else if (playerState === 2 || playerState === 0 || playerState === 5) {
          setIsPlaying(false);
        }

        const currentTime = player.getCurrentTime();

        if (typeof currentTime !== "number" || Number.isNaN(currentTime)) {
          return;
        }

        const milliseconds = Math.max(0, Math.floor(currentTime * 1000));

        if (Math.abs(milliseconds - lastReportedTimeRef.current) < 250) {
          return;
        }

        lastReportedTimeRef.current = milliseconds;
        onTimeChangeRef.current(milliseconds);
      }, 250);
    };

    setPlayerError(null);
    setIsPlayerReady(false);
    setHasStartedPlayback(false);
    setIsPlaying(false);

    void loadYouTubeIframeApi()
      .then(() => {
        if (cancelled || !containerRef.current || !window.YT?.Player) {
          return;
        }

        playerRef.current?.destroy();
        playerRef.current = new window.YT.Player(containerRef.current, {
          width: "100%",
          height: "100%",
          videoId,
          playerVars: {
            // Clean player: no YouTube chrome. We drive playback via the API
            // and overlay our own controls + subtitles.
            controls: 0,
            disablekb: 1,
            enablejsapi: 1,
            fs: 0,
            iv_load_policy: 3,
            cc_load_policy: 0,
            modestbranding: 1,
            origin: window.location.origin,
            playsinline: 1,
            rel: 0,
          },
          events: {
            onReady: () => {
              if (cancelled) {
                return;
              }

              setIsPlayerReady(true);
              startTimePolling();
            },
            onStateChange: (event) => {
              if (event.data === 1 || event.data === 3) {
                setHasStartedPlayback(true);
                setIsPlaying(true);
              } else if (event.data === 2 || event.data === 0 || event.data === 5) {
                setIsPlaying(false);
              }
            },
            onError: (event) => {
              if ([2, 5, 100, 101, 150].includes(event.data)) {
                setPlayerError(event.data);
              }
            },
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPlayerError(0);
        }
      });

    return () => {
      cancelled = true;
      if (timeInterval) {
        window.clearInterval(timeInterval);
      }
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [videoId]);

  function handleTogglePlayback() {
    const player = playerRef.current;

    if (!player) {
      return;
    }

    const playerState = typeof player.getPlayerState === "function"
      ? player.getPlayerState()
      : -1;

    if (playerState === 1 || playerState === 3) {
      if (typeof player.pauseVideo === "function") {
        player.pauseVideo();
      }

      setIsPlaying(false);
      return;
    }

    if (typeof player.playVideo === "function") {
      player.playVideo();
    }

    setHasStartedPlayback(true);
    setIsPlaying(true);
  }

  const ready = isPlayerReady && !playerError;
  const showCenterPlay = ready && !hasStartedPlayback;
  const showPlaybackControl = ready && hasStartedPlayback;

  return (
    <>
      <div
        aria-label={title}
        className={cn(
          "absolute inset-0 z-0 size-full touch-manipulation [&_iframe]:pointer-events-none [&_iframe]:absolute [&_iframe]:inset-0 [&_iframe]:size-full [&_iframe]:h-full [&_iframe]:w-full [&>div]:absolute [&>div]:inset-0 [&>div]:size-full",
          playerError ? "pointer-events-none opacity-0" : null,
        )}
        ref={containerRef}
      />
      {ready ? (
        <button
          aria-label={isPlaying ? "Pause video" : "Play video"}
          className="absolute inset-0 z-10 cursor-pointer"
          onClick={handleTogglePlayback}
          type="button"
        />
      ) : null}
      {showCenterPlay ? (
        <div
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-vidura-ink bg-cover bg-center"
          style={{
            backgroundImage:
              `url(https://i.ytimg.com/vi/${videoId}/hqdefault.jpg)`,
          }}
        >
          <span className="absolute inset-0 bg-black/30" />
          <span className="relative grid size-20 place-items-center rounded-full border-2 border-white/90 bg-black/50 text-white shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
            <CirclePlayIcon className="ml-1 size-10" />
          </span>
        </div>
      ) : null}
      {showPlaybackControl ? (
        <button
          aria-label={isPlaying ? "Pause video" : "Play video"}
          className="pointer-events-auto absolute bottom-3 left-3 z-30 grid size-12 place-items-center rounded-full border-2 border-white/90 bg-black/60 text-white shadow-[0_6px_18px_rgba(0,0,0,0.45)] touch-manipulation"
          onClick={handleTogglePlayback}
          type="button"
        >
          {isPlaying ? (
            <PauseIcon className="size-6" />
          ) : (
            <CirclePlayIcon className="ml-0.5 size-6" />
          )}
        </button>
      ) : null}
      {playerError ? (
        <div className="absolute inset-0 grid place-items-center bg-vidura-ink p-6 text-center text-white">
          <div className="max-w-sm">
            <div className="mx-auto grid size-16 place-items-center rounded-full border-2 border-white/70 text-white/80">
              <CirclePlayIcon className="size-8" />
            </div>
            <h3 className="mt-4 text-2xl font-black">Playback blocked here</h3>
            <p className="mt-2 text-sm font-bold text-white/70">
              This video can only be watched on YouTube.
            </p>
            <Button
              asChild
              className="mt-5 border-2 border-white bg-vidura-sun text-foreground hover:bg-vidura-sun/90"
            >
              <a href={watchUrl ?? buildYouTubeWatchUrl(videoId)} rel="noreferrer" target="_blank">
                <LinkIcon data-icon="inline-start" />
                Open on YouTube
              </a>
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// Memoized: WatchScreen re-renders 4x/second while the player reports playback
// time; these panels only depend on videoId/activeSegmentId and must not
// re-render with it.
const TranscriptPanel = memo(function TranscriptPanel({
  activeSegmentId,
  isProcessing = false,
  failed = false,
  errorMessage = null,
  videoId,
}: {
  activeSegmentId?: string | null;
  isProcessing?: boolean;
  failed?: boolean;
  errorMessage?: string | null;
  videoId: string;
}) {
  const queryClient = useQueryClient();
  const collapsed = useAppStore((state) => state.transcriptCollapsed);
  const setCollapsed = useAppStore((state) => state.setTranscriptCollapsed);
  const transcriptQuery = useQuery({
    queryKey: videoQueryKeys.transcript(videoId),
    queryFn: () => fetchVideoTranscript(videoId),
    // Fallback only — realtime pushes transcript updates as they land.
    refetchInterval: isProcessing ? 5_000 : false,
  });
  const invalidateAfterRegenerate = async () => {
    await queryClient.invalidateQueries({ queryKey: videoQueryKeys.all });
    await queryClient.invalidateQueries({
      queryKey: videoQueryKeys.transcript(videoId),
    });
  };
  const regenerateMutation = useMutation({
    mutationFn: () =>
      regenerateSubtitles({
        videoId,
        rebuildContext: true,
      }),
    onSuccess: invalidateAfterRegenerate,
  });
  const regenerateTranscriptMutation = useMutation({
    mutationFn: () =>
      regenerateSubtitles({
        videoId,
        rebuildContext: true,
        regenerateTranscript: true,
      }),
    onSuccess: invalidateAfterRegenerate,
  });
  const selectedTranscript = transcriptQuery.data ?? [];
  const isLoading = transcriptQuery.isPending || transcriptQuery.isFetching;
  const isRegenerating = regenerateMutation.isPending ||
    regenerateTranscriptMutation.isPending || isProcessing;
  const regenerateError = regenerateMutation.error ??
    regenerateTranscriptMutation.error;

  return (
    <StickerCard>
      <Tabs defaultValue="sinhala">
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <button
                aria-expanded={!collapsed}
                className="flex items-center gap-2 text-left"
                onClick={() => setCollapsed(!collapsed)}
                type="button"
              >
                <CardTitle className="font-display text-2xl font-black">
                  Transcript
                </CardTitle>
                <ChevronDownIcon
                  className={cn(
                    "size-5 shrink-0 transition-transform",
                    collapsed && "-rotate-90",
                  )}
                />
              </button>
              {!collapsed ? (
                <TabsList className="border-2 border-foreground bg-vidura-cream">
                  <TabsTrigger value="sinhala">Sinhala</TabsTrigger>
                  <TabsTrigger value="bilingual">Bilingual</TabsTrigger>
                </TabsList>
              ) : null}
            </div>
            {collapsed ? null : (
            <div className="flex flex-col gap-2 sm:flex-row sm:self-start">
              <Button
                className="w-full border-2 border-foreground sm:w-auto"
                disabled={isRegenerating || selectedTranscript.length === 0}
                onClick={() => {
                  regenerateMutation.mutate();
                }}
                size="sm"
                variant="outline"
              >
                {regenerateMutation.isPending ? (
                  <Loader2Icon className="animate-spin" data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                Regenerate subtitles
              </Button>
              <Button
                className="w-full border-2 border-foreground sm:w-auto"
                disabled={isRegenerating}
                onClick={() => {
                  regenerateTranscriptMutation.mutate();
                }}
                size="sm"
                variant="outline"
              >
                {regenerateTranscriptMutation.isPending ? (
                  <Loader2Icon className="animate-spin" data-icon="inline-start" />
                ) : (
                  <ListVideoIcon data-icon="inline-start" />
                )}
                Regenerate transcript
              </Button>
            </div>
            )}
          </div>
          {regenerateError ? (
            <p className="mt-2 text-sm font-semibold text-vidura-coral">
              {regenerateError instanceof Error
                ? regenerateError.message
                : "Could not start regeneration."}
            </p>
          ) : null}
          {(isLoading || isRegenerating) && !collapsed ? (
            <div className="mt-3">
              <InlineLoadingNotice
                label={
                  regenerateTranscriptMutation.isPending
                    ? "Refetching the transcript and rebuilding subtitles..."
                    : regenerateMutation.isPending
                    ? "Rebuilding Sinhala subtitles with full video context..."
                    : isLoading
                    ? "Loading Sinhala subtitles..."
                    : "Translating more subtitle lines..."
                }
              />
            </div>
          ) : null}
        </CardHeader>
        {collapsed ? null : (
        <CardContent>
          {failed && selectedTranscript.length === 0 ? (
            <div className="rounded-md border-2 border-foreground bg-vidura-coral/25 p-4">
              <p className="text-sm font-black">Processing failed</p>
              <p className="mt-1 text-sm font-semibold text-foreground/70">
                {errorMessage?.includes("transcript") ||
                    errorMessage?.includes("caption")
                  ? "Couldn't fetch this video's transcript from YouTube. You can import a transcript file from the Add screen, or try Regenerate transcript."
                  : errorMessage ?? "Something went wrong while processing this video."}
              </p>
            </div>
          ) : null}
          {!failed && !isLoading && !isRegenerating &&
              selectedTranscript.length === 0 ? (
            <p className="text-sm font-black text-foreground/60">
              Transcript lines will appear here as processing stores them.
            </p>
          ) : null}
          <TabsContent className="mt-0" value="sinhala">
            <TranscriptRows
              activeSegmentId={activeSegmentId}
              isLoading={isLoading || isRegenerating}
              mode="sinhala"
              segments={selectedTranscript}
            />
          </TabsContent>
          <TabsContent className="mt-0" value="bilingual">
            <TranscriptRows
              activeSegmentId={activeSegmentId}
              isLoading={isLoading || isRegenerating}
              mode="bilingual"
              segments={selectedTranscript}
            />
          </TabsContent>
        </CardContent>
        )}
      </Tabs>
    </StickerCard>
  );
});

const TranscriptRows = memo(function TranscriptRows({
  activeSegmentId,
  isLoading = false,
  mode,
  segments,
}: {
  activeSegmentId?: string | null;
  isLoading?: boolean;
  mode: "sinhala" | "bilingual";
  segments: TranscriptSegment[];
}) {
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeSegmentId]);

  return (
    <ScrollArea className="h-[260px] pr-3">
      <div className="flex flex-col gap-2">
        {segments.length === 0 && isLoading ? (
          <div className="rounded-md border-2 border-dashed border-foreground bg-vidura-cream p-4">
            <InlineLoadingNotice label="Waiting for the first translated lines..." />
          </div>
        ) : null}
        {segments.map((segment) => (
          <button
            className={cn(
              "grid grid-cols-[56px_1fr] gap-3 rounded-md border-2 border-foreground bg-card p-3 text-left shadow-[2px_2px_0_var(--vidura-ink)]",
              segment.id === activeSegmentId && "bg-vidura-mint"
            )}
            key={segment.id}
            ref={segment.id === activeSegmentId ? activeRowRef : null}
            type="button"
          >
            <Badge className="border border-foreground bg-vidura-sun text-foreground">
              {segment.time}
            </Badge>
            <span className="text-sm font-semibold leading-relaxed">
              {mode === "bilingual" ? (
                <>
                  <span>{segment.original}</span>
                  <span className="mt-1 block text-foreground/65">
                    {segment.sinhala ?? "Translation unavailable"}
                  </span>
                </>
              ) : (
                segment.sinhala ?? (
                  <span className="text-foreground/50">
                    Translation unavailable
                  </span>
                )
              )}
            </span>
          </button>
        ))}
        {segments.length > 0 && isLoading ? (
          <div className="rounded-md border-2 border-dashed border-foreground bg-vidura-cream p-3">
            <InlineLoadingNotice label="More subtitles are on the way..." />
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
});

// Timestamped study notes. Notes are stored per video and indexed so the
// chat assistant can retrieve them alongside the transcript.
const NotesPanel = memo(function NotesPanel({
  videoId,
  getCurrentTimeMs,
}: {
  videoId: string;
  getCurrentTimeMs: () => number;
}) {
  const [draft, setDraft] = useState("");
  const queryClient = useQueryClient();
  const notesQuery = useQuery({
    queryKey: videoQueryKeys.notes(videoId),
    queryFn: () => fetchVideoNotes(videoId),
  });
  const invalidateNotes = () =>
    queryClient.invalidateQueries({ queryKey: videoQueryKeys.notes(videoId) });
  const addNoteMutation = useMutation({
    mutationFn: addVideoNote,
    onSuccess: invalidateNotes,
  });
  const deleteNoteMutation = useMutation({
    mutationFn: deleteVideoNote,
    onSuccess: invalidateNotes,
  });
  const notes = notesQuery.data ?? [];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = draft.trim();

    if (!content || addNoteMutation.isPending) {
      return;
    }

    addNoteMutation.mutate({
      videoId,
      timestampMs: getCurrentTimeMs(),
      content,
    });
    setDraft("");
  }

  return (
    <StickerCard>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="font-display text-2xl font-black">
              Notes
            </CardTitle>
            <CardDescription>
              Saved at the current playback time.
            </CardDescription>
          </div>
          <NotebookPenIcon className="size-6 shrink-0" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form onSubmit={handleSubmit}>
          <InputGroup className="h-auto border-2 border-foreground bg-card">
            <InputGroupTextarea
              className="min-h-12"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Write a note about this moment..."
              value={draft}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                className="bg-vidura-mint text-foreground"
                disabled={!draft.trim() || addNoteMutation.isPending}
                size="icon-sm"
                type="submit"
              >
                {addNoteMutation.isPending ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <PlusIcon />
                )}
                <span className="sr-only">Add note</span>
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
        {addNoteMutation.isError ? (
          <p className="text-sm font-semibold text-vidura-coral">
            {addNoteMutation.error instanceof Error
              ? addNoteMutation.error.message
              : "Could not save the note."}
          </p>
        ) : null}
        {notes.length === 0 && !notesQuery.isPending ? (
          <p className="text-sm font-bold text-foreground/60">
            No notes yet. Pause at an important moment and jot one down.
          </p>
        ) : null}
        {notes.length > 0 ? (
          <div className="flex max-h-[220px] flex-col gap-2 overflow-y-auto pr-2">
            {notes.map((note) => (
              <div
                className="grid animate-vidura-fade-in-up grid-cols-[56px_1fr_auto] items-start gap-3 rounded-md border-2 border-foreground bg-card p-3 shadow-[2px_2px_0_var(--vidura-ink)]"
                key={note.id}
              >
                <Badge className="border border-foreground bg-vidura-sun text-foreground">
                  {formatNoteTimestamp(note.timestampMs)}
                </Badge>
                <p className="whitespace-pre-wrap text-sm font-semibold leading-relaxed">
                  {note.content}
                </p>
                <Button
                  aria-label="Delete note"
                  disabled={deleteNoteMutation.isPending}
                  onClick={() => deleteNoteMutation.mutate(note.id)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </StickerCard>
  );
});

function formatNoteTimestamp(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes.toString().padStart(2, "0")}:${
    seconds.toString().padStart(2, "0")
  }`;
}

type ChatPanelVariant = "panel" | "overlay" | "page";

const libraryQuickPrompts = [
  "What videos do I have?",
  "Summarize my latest video",
  "What did I note down recently?",
];

// videoId null = the library-wide assistant that can answer across every
// video in the library with title + timestamp citations. threadId selects a
// saved library session; when null the server opens a fresh session on the
// first message and reports it through onThreadCreated.
const ChatPanel = memo(function ChatPanel({
  videoId,
  threadId = null,
  onThreadCreated,
  variant = "panel",
}: {
  videoId: string | null;
  threadId?: string | null;
  onThreadCreated?: (threadId: string) => void;
  variant?: ChatPanelVariant;
}) {
  const [draft, setDraft] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [chatError, setChatError] = useState("");
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatQuery = useQuery({
    queryKey: videoId
      ? videoQueryKeys.chat(videoId)
      : chatSessionKeys.messages(threadId),
    queryFn: () =>
      videoId
        ? fetchChatMessages(videoId)
        : threadId
        ? fetchSessionMessages(threadId)
        : Promise.resolve([]),
    enabled: Boolean(videoId || threadId),
  });
  const messages = chatQuery.data ?? [];
  const isStreaming = pendingQuestion !== null;
  const isThinking = isStreaming && streamingAnswer.length === 0;
  const isLoadingHistory = chatQuery.isPending && Boolean(videoId || threadId);
  // The edge function persists the user message immediately, so a realtime
  // refetch can pull it into `messages` while we still show the optimistic
  // pending bubble — that briefly duplicated it. Suppress the optimistic
  // bubble once the persisted copy has landed.
  const lastMessage = messages[messages.length - 1];
  const showPendingBubble = pendingQuestion !== null &&
    !(lastMessage?.role === "user" && lastMessage.content === pendingQuestion);

  useEffect(() => {
    const container = scrollRef.current;

    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages.length, streamingAnswer, pendingQuestion]);

  async function askQuestion(question: string) {
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion || isStreaming) {
      return;
    }

    setDraft("");
    setChatError("");
    setPendingQuestion(trimmedQuestion);
    setStreamingAnswer("");

    let createdThreadId: string | null = null;

    try {
      await streamVideoChat({
        videoId,
        threadId,
        question: trimmedQuestion,
        onDelta: (text) => setStreamingAnswer((current) => current + text),
        onThreadId: (id) => {
          createdThreadId = id;
        },
      });

      if (videoId) {
        await queryClient.invalidateQueries({
          queryKey: videoQueryKeys.chat(videoId),
        });
      } else {
        const finalThreadId = threadId ?? createdThreadId;

        if (finalThreadId) {
          // Warm the cache before the route switches to the new session so
          // the conversation never flashes a loading state.
          await queryClient.prefetchQuery({
            queryKey: chatSessionKeys.messages(finalThreadId),
            queryFn: () => fetchSessionMessages(finalThreadId),
          });
          await queryClient.invalidateQueries({
            queryKey: chatSessionKeys.messages(finalThreadId),
          });
          void queryClient.invalidateQueries({
            queryKey: chatSessionKeys.list,
            exact: true,
          });
        }
      }
    } catch (streamError) {
      setChatError(
        streamError instanceof Error
          ? streamError.message
          : "Could not get an answer. Try again.",
      );
    } finally {
      if (createdThreadId && !threadId && !videoId) {
        onThreadCreated?.(createdThreadId);
      }

      setPendingQuestion(null);
      setStreamingAnswer("");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void askQuestion(draft);
  }

  const emptyNotice = videoId
    ? "Ask anything about this video — answers cite the exact timestamps."
    : "Ask anything about your library — answers name the video and timestamp.";
  const prompts = videoId ? quickPrompts.slice(0, 3) : libraryQuickPrompts;
  const showPrompts = variant === "page"
    ? messages.length === 0 && !isStreaming && !isLoadingHistory
    : true;
  const scrollHeightClass = variant === "panel"
    ? "h-[230px]"
    : "min-h-0 flex-1";

  const body = (
    <>
      {showPrompts ? (
        <div className="flex flex-wrap gap-2">
          {prompts.map((prompt) => (
            <Button
              className="h-auto rounded-md border-2 border-foreground bg-vidura-cream px-3 py-2 text-xs"
              disabled={isStreaming}
              key={prompt}
              onClick={() => void askQuestion(prompt)}
              type="button"
              variant="outline"
            >
              {prompt}
            </Button>
          ))}
        </div>
      ) : null}
      <div
        className={cn("overflow-y-auto pr-2", scrollHeightClass)}
        ref={scrollRef}
      >
        <div className="flex flex-col gap-3">
          {isLoadingHistory ? (
            <div className="rounded-lg border-2 border-dashed border-foreground bg-vidura-cream p-3 text-sm font-bold leading-relaxed text-foreground/65">
              Loading chat...
            </div>
          ) : null}
          {!isLoadingHistory && messages.length === 0 && !isStreaming ? (
            <div className="rounded-lg border-2 border-dashed border-foreground bg-vidura-cream p-3 text-sm font-bold leading-relaxed text-foreground/65">
              {emptyNotice}
            </div>
          ) : null}
          {messages.map((message) => (
            <ChatBubble
              animate
              content={message.content}
              key={message.id}
              role={message.role}
            />
          ))}
          {showPendingBubble ? (
            <ChatBubble animate content={pendingQuestion ?? ""} role="user" />
          ) : null}
          {isThinking ? (
            <div className="flex max-w-[88%] animate-vidura-fade-in-up items-center gap-2 rounded-lg border-2 border-foreground bg-card p-3 text-sm font-bold text-foreground/65 shadow-[2px_2px_0_var(--vidura-ink)]">
              <Loader2Icon className="size-4 shrink-0 animate-spin" />
              Thinking...
            </div>
          ) : null}
          {isStreaming && streamingAnswer ? (
            <ChatBubble content={streamingAnswer} role="assistant" streaming />
          ) : null}
          {chatError ? (
            <div className="rounded-lg border-2 border-foreground bg-vidura-coral/25 p-3 text-sm font-bold text-foreground">
              {chatError}
            </div>
          ) : null}
        </div>
      </div>
      <form className="shrink-0" onSubmit={handleSubmit}>
        <InputGroup className="h-auto border-2 border-foreground bg-card">
          <InputGroupTextarea
            className="min-h-16"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void askQuestion(draft);
              }
            }}
            placeholder={
              videoId ? "Ask about this video..." : "Ask about any video..."
            }
            value={draft}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              className="bg-vidura-purple text-foreground"
              disabled={!draft.trim() || isStreaming}
              size="icon-sm"
              type="submit"
            >
              {isStreaming ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <SendIcon />
              )}
              <span className="sr-only">Send message</span>
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </>
  );

  // The page variant renders flat (no card chrome): messages fill the page
  // and the input stays pinned above the bottom navigation.
  if (variant === "page") {
    return <div className="flex min-h-0 flex-1 flex-col gap-3">{body}</div>;
  }

  return (
    <StickerCard
      className={cn(
        variant === "overlay"
          ? "flex min-h-0 flex-1 flex-col border-0 shadow-none"
          : "min-h-[360px]",
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="font-display text-2xl font-black">
              Chat
            </CardTitle>
            <CardDescription>Ask about this video.</CardDescription>
          </div>
          <Avatar className="border-2 border-foreground bg-vidura-purple">
            <AvatarFallback className="bg-transparent font-black text-foreground">
              AI
            </AvatarFallback>
          </Avatar>
        </div>
      </CardHeader>
      <CardContent
        className={cn(
          "flex flex-col gap-3",
          variant === "overlay" && "min-h-0 flex-1",
        )}
      >
        {body}
      </CardContent>
    </StickerCard>
  );
});

function ChatBubble({
  content,
  role,
  streaming = false,
  animate = false,
}: {
  content: string;
  role: "user" | "assistant";
  streaming?: boolean;
  animate?: boolean;
}) {
  return (
    <div
      className={cn(
        "max-w-[88%] rounded-lg border-2 border-foreground p-3 text-sm font-medium leading-relaxed shadow-[2px_2px_0_var(--vidura-ink)]",
        role === "user"
          ? "ml-auto whitespace-pre-wrap bg-vidura-purple"
          : "bg-card",
        animate && "animate-vidura-fade-in-up",
      )}
    >
      {role === "assistant" ? (
        <div className="chat-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        content
      )}
      {streaming ? (
        <span className="ml-1 inline-block h-4 w-2 animate-pulse rounded-sm bg-foreground/70 align-text-bottom" />
      ) : null}
    </div>
  );
}

// Sticker-styled confirmation dialog for destructive actions.
function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  destructive = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    document.addEventListener("keydown", handleKey);

    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 animate-vidura-fade-in bg-foreground/40"
        onClick={busy ? undefined : onCancel}
      />
      <div
        aria-modal="true"
        className="relative w-full max-w-sm animate-vidura-scale-in rounded-lg border-2 border-foreground bg-card p-5 shadow-[6px_6px_0_var(--vidura-ink)]"
        role="alertdialog"
      >
        <h2 className="font-display text-2xl font-black">{title}</h2>
        {description ? (
          <p className="mt-2 text-sm font-semibold text-foreground/65">
            {description}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            className="border-2 border-foreground"
            disabled={busy}
            onClick={onCancel}
            variant="outline"
          >
            {cancelLabel}
          </Button>
          <Button
            className={cn(
              "border-2 border-foreground",
              destructive
                ? "bg-vidura-coral text-foreground hover:bg-vidura-coral/90"
                : "bg-vidura-mint text-foreground hover:bg-vidura-mint/90",
            )}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Chat session history: pick a previous library chat to continue, rename it,
// or delete it. Rendered from the mobile top bar and the desktop chat header.
function ChatSessionsSheet({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const activeThreadId = location.pathname.startsWith("/chats/session/")
    ? location.pathname.split("/")[3] ?? null
    : null;
  const sessionsQuery = useQuery({
    queryKey: chatSessionKeys.list,
    queryFn: fetchChatSessions,
    enabled: open,
  });
  const invalidateSessions = () =>
    queryClient.invalidateQueries({ queryKey: chatSessionKeys.list, exact: true });
  const renameMutation = useMutation({
    mutationFn: renameChatSession,
    onSuccess: invalidateSessions,
  });
  const deleteMutation = useMutation({
    mutationFn: deleteChatSession,
    onSuccess: (_, deletedThreadId) => {
      void invalidateSessions();
      setRemovingId(null);

      if (deletedThreadId === activeThreadId) {
        navigate("/chats");
      }
    },
  });
  const sessions = sessionsQuery.data ?? [];
  const pendingDeleteSession = sessions.find(
    (session) => session.id === pendingDeleteId,
  );

  function openSession(threadId: string) {
    setOpen(false);
    navigate(`/chats/session/${threadId}`);
  }

  function confirmDelete() {
    if (!pendingDeleteId) {
      return;
    }

    const id = pendingDeleteId;
    setPendingDeleteId(null);
    // Play the row's collapse animation before removing it from the list.
    setRemovingId(id);
    window.setTimeout(() => deleteMutation.mutate(id), 220);
  }

  function submitRename(threadId: string) {
    const title = renameDraft.trim();

    if (title) {
      renameMutation.mutate({ threadId, title });
    }

    setRenamingId(null);
    setRenameDraft("");
  }

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        className="flex w-[min(100vw-1.5rem,20rem)] flex-col border-2 border-foreground bg-background p-0"
        side="right"
      >
        <SheetHeader className="border-b-2 border-foreground px-4 py-4">
          <SheetTitle className="font-display text-2xl font-black">
            Chat history
          </SheetTitle>
          <SheetDescription className="font-semibold text-foreground/55">
            Continue, rename, or delete a session.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
          <Button
            className="justify-start border-2 border-foreground bg-vidura-mint"
            onClick={() => {
              setOpen(false);
              navigate("/chats");
            }}
            variant="secondary"
          >
            <SquarePenIcon data-icon="inline-start" />
            New chat
          </Button>
          {sessionsQuery.isPending ? (
            <InlineLoadingNotice label="Loading sessions..." />
          ) : null}
          {!sessionsQuery.isPending && sessions.length === 0 ? (
            <p className="px-1 text-sm font-bold text-foreground/60">
              No saved chats yet. Start one and it will appear here.
            </p>
          ) : null}
          {sessions.map((session) => (
            <div
              className={cn(
                "vidura-collapsible animate-vidura-fade-in-up",
                removingId === session.id && "vidura-collapsible--removing",
              )}
              key={session.id}
            >
              <div
                className={cn(
                  "flex items-center gap-1 rounded-md border-2 border-foreground bg-card p-2 shadow-[2px_2px_0_var(--vidura-ink)] transition-transform hover:-translate-y-0.5",
                  session.id === activeThreadId && "bg-vidura-mint",
                )}
              >
              {renamingId === session.id ? (
                <>
                  <InputGroup className="h-9 flex-1 border-2 border-foreground bg-background">
                    <InputGroupInput
                      autoFocus
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          submitRename(session.id);
                        }

                        if (event.key === "Escape") {
                          setRenamingId(null);
                        }
                      }}
                      value={renameDraft}
                    />
                  </InputGroup>
                  <Button
                    aria-label="Save name"
                    onClick={() => submitRename(session.id)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <CheckIcon className="size-4" />
                  </Button>
                  <Button
                    aria-label="Cancel rename"
                    onClick={() => setRenamingId(null)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <XIcon className="size-4" />
                  </Button>
                </>
              ) : (
                <>
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => openSession(session.id)}
                    type="button"
                  >
                    <p className="truncate text-sm font-black leading-tight">
                      {session.title}
                    </p>
                    <p className="text-[0.68rem] font-semibold text-foreground/55">
                      {new Date(session.updatedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </button>
                  <Button
                    aria-label="Rename chat"
                    onClick={() => {
                      setRenamingId(session.id);
                      setRenameDraft(session.title);
                    }}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    aria-label="Delete chat"
                    disabled={deleteMutation.isPending}
                    onClick={() => setPendingDeleteId(session.id)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </>
              )}
              </div>
            </div>
          ))}
        </div>
      </SheetContent>
      <ConfirmDialog
        busy={deleteMutation.isPending}
        description={pendingDeleteSession
          ? `"${pendingDeleteSession.title}" and its messages will be permanently deleted.`
          : undefined}
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={confirmDelete}
        open={pendingDeleteId !== null}
        title="Delete this chat?"
      />
    </Sheet>
  );
}

// Floating chat launcher for mobile — opens the per-video chat as a
// bottom-sheet overlay so the conversation gets the whole screen.
function FloatingChatButton({ videoId }: { videoId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger asChild>
        <Button
          aria-label="Chat about this video"
          className="fixed bottom-24 right-4 z-40 size-14 rounded-full border-2 border-foreground bg-vidura-purple text-foreground shadow-[4px_4px_0_var(--vidura-ink)] hover:bg-vidura-purple xl:hidden"
          size="icon-lg"
        >
          <MessageCircleIcon className="size-6" />
        </Button>
      </SheetTrigger>
      <SheetContent
        className="flex h-[88dvh] flex-col gap-0 rounded-t-xl border-2 border-foreground bg-background p-0"
        side="bottom"
      >
        <SheetHeader className="border-b-2 border-foreground px-4 py-3">
          <SheetTitle className="font-display text-2xl font-black">
            Video chat
          </SheetTitle>
          <SheetDescription className="sr-only">
            Chat about the current video
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2">
          <ChatPanel variant="overlay" videoId={videoId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ChatScreen() {
  // /chats always starts a fresh session; /chats/session/:threadId resumes a
  // saved one from the history sheet.
  const { threadId } = useParams();
  const navigate = useNavigate();

  return (
    <section className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 pb-2 lg:pb-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="hidden lg:block">
          <h2 className="font-display text-4xl font-black tracking-normal">
            Library chat
          </h2>
          <p className="font-medium text-foreground/60">
            Ask across all your videos — answers cite titles and timestamps.
          </p>
        </div>
        <div className="flex items-center gap-2 lg:ml-auto">
          <Button
            className="border-2 border-foreground"
            onClick={() => navigate("/chats")}
            size="sm"
            variant="outline"
          >
            <SquarePenIcon data-icon="inline-start" />
            New chat
          </Button>
          <span className="hidden lg:inline-flex">
            <ChatSessionsSheet
              trigger={
                <Button
                  className="border-2 border-foreground"
                  size="sm"
                  variant="outline"
                >
                  <HistoryIcon data-icon="inline-start" />
                  History
                </Button>
              }
            />
          </span>
        </div>
      </div>
      <ChatPanel
        key={threadId ?? "new"}
        onThreadCreated={(createdThreadId) =>
          navigate(`/chats/session/${createdThreadId}`, { replace: true })}
        threadId={threadId ?? null}
        variant="page"
        videoId={null}
      />
    </section>
  );
}

function VideoInfoPanel({ video }: { video: LibraryVideo }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteVideoMutation = useMutation({
    mutationFn: deleteVideo,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: videoQueryKeys.all });
      navigate("/library");
    },
  });
  const videoUrl =
    video.youtubeUrl ??
    (isYouTubeVideoId(video.youtubeVideoId)
      ? buildYouTubeWatchUrl(video.youtubeVideoId)
      : null);

  async function shareVideo() {
    if (!videoUrl) {
      return;
    }

    try {
      if (navigator.share) {
        await navigator.share({
          title: video.title,
          url: videoUrl,
        });
        return;
      }

      await navigator.clipboard.writeText(videoUrl);
    } catch {
      // Sharing can be cancelled by the user or blocked by browser permissions.
    }
  }

  function openVideo() {
    if (!videoUrl) {
      return;
    }

    window.open(videoUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <StickerPanel title="Video info">
      <div className="flex gap-3">
        <div
          className={cn(
            "grid size-20 shrink-0 place-items-center overflow-hidden rounded-md border-2 border-foreground",
            video.accent
          )}
        >
          {video.thumbnailUrl ? (
            <img alt="" className="size-full object-cover" src={video.thumbnailUrl} />
          ) : (
            <video.Icon className="size-9" />
          )}
        </div>
        <div>
          <p className="font-black leading-tight">{video.title}</p>
          <p className="mt-1 text-xs font-semibold text-foreground/60">
            {video.channel}
          </p>
        </div>
      </div>
      <div className="mt-3">
        <SubtitleProvenanceBadges video={video} />
      </div>
      <Separator className="my-4" />
      <div className="flex flex-col gap-2">
        <Button className="justify-start border-2 border-foreground" variant="outline">
          <ListVideoIcon data-icon="inline-start" />
          Add to watch later
        </Button>
        <Button
          className="justify-start border-2 border-foreground"
          disabled={!videoUrl}
          onClick={() => void shareVideo()}
          variant="outline"
        >
          <ListVideoIcon data-icon="inline-start" />
          Share video
        </Button>
        <Button
          className="justify-start border-2 border-foreground"
          disabled={!videoUrl}
          onClick={openVideo}
          variant="outline"
        >
          <ListVideoIcon data-icon="inline-start" />
          Open in YouTube
        </Button>
        <Button
          className="justify-start border-2 border-foreground"
          disabled={deleteVideoMutation.isPending}
          onClick={() => setConfirmDelete(true)}
          variant="outline"
        >
          <Trash2Icon data-icon="inline-start" />
          Delete video
        </Button>
      </div>
      <ConfirmDialog
        busy={deleteVideoMutation.isPending}
        description={`"${video.title}" and its transcript, subtitles, notes, and chats will be permanently deleted.`}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => deleteVideoMutation.mutate(video.id)}
        open={confirmDelete}
        title="Delete this video?"
      />
    </StickerPanel>
  );
}

function SettingsScreen() {
  const subtitleEnabled = useAppStore((state) => state.subtitleEnabled);
  const subtitlePlacement = useAppStore((state) => state.subtitlePlacement);
  const subtitleSize = useAppStore((state) => state.subtitleSize);
  const subtitleOpacity = useAppStore((state) => state.subtitleOpacity);
  const setSubtitleEnabled = useAppStore((state) => state.setSubtitleEnabled);
  const setSubtitlePlacement = useAppStore((state) => state.setSubtitlePlacement);
  const setSubtitleSize = useAppStore((state) => state.setSubtitleSize);
  const setSubtitleOpacity = useAppStore((state) => state.setSubtitleOpacity);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4">
      <StickerPanel
        description="Tune subtitle readability for mobile and desktop playback."
        title="Settings"
      >
        <FieldGroup>
          <Field orientation="horizontal">
            <div className="flex-1">
              <FieldLabel>SI subtitles</FieldLabel>
              <FieldDescription>Show translated Sinhala captions.</FieldDescription>
            </div>
            <Switch
              checked={subtitleEnabled}
              onCheckedChange={setSubtitleEnabled}
            />
          </Field>
          <FieldSet>
            <FieldTitle>Subtitle placement</FieldTitle>
            <FieldDescription>
              Keep captions below the video on mobile, or overlay them on the
              player when you want a theater-style view. Fullscreen mode always
              overlays subtitles so landscape playback stays readable.
            </FieldDescription>
            <ToggleGroup
              className="justify-start"
              onValueChange={(value) => {
                if (value === "overlay" || value === "below") {
                  setSubtitlePlacement(value);
                }
              }}
              type="single"
              value={subtitlePlacement}
            >
              <ToggleGroupItem
                className="rounded-md border-2 border-foreground bg-card data-[state=on]:bg-vidura-mint"
                value="below"
              >
                Below video
              </ToggleGroupItem>
              <ToggleGroupItem
                className="rounded-md border-2 border-foreground bg-card data-[state=on]:bg-vidura-mint"
                value="overlay"
              >
                Overlay on video
              </ToggleGroupItem>
            </ToggleGroup>
          </FieldSet>
          <Field>
            <FieldLabel>Language</FieldLabel>
            <Select defaultValue="si">
              <SelectTrigger className="h-11 border-2 border-foreground bg-card">
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {languageOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <FieldSet>
            <FieldTitle>Subtitle size</FieldTitle>
            <div className="flex items-center gap-3">
              <Badge className="border-2 border-foreground bg-card text-foreground">
                A-
              </Badge>
              <Slider
                max={28}
                min={16}
                onValueChange={([value]) => setSubtitleSize(value)}
                step={1}
                value={[subtitleSize]}
              />
              <Badge className="border-2 border-foreground bg-card text-foreground">
                A+
              </Badge>
            </div>
          </FieldSet>
          <FieldSet>
            <FieldTitle>Background opacity</FieldTitle>
            <div className="flex items-center gap-3">
              <Slider
                max={100}
                min={35}
                onValueChange={([value]) => setSubtitleOpacity(value)}
                step={1}
                value={[subtitleOpacity]}
              />
              <Badge className="border-2 border-foreground bg-vidura-sun text-foreground">
                {subtitleOpacity}%
              </Badge>
            </div>
          </FieldSet>
        </FieldGroup>
      </StickerPanel>
      <NotificationSettingsPanel />
      <TranslationSettingsPanel />
      <ChatSettingsPanel />
    </section>
  );
}

function NotificationSettingsPanel() {
  const [supported] = useState(() => pushSupported());
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // iOS only allows web push from a Safari-installed Home-Screen app.
  const isIOS = typeof navigator !== "undefined" &&
    /iphone|ipad|ipod/i.test(navigator.userAgent);
  const unsupportedHint = isIOS
    ? "On iPhone/iPad: open this site in Safari, tap Share → Add to Home Screen, then open Vidura from the icon to turn on notifications."
    : "Not supported on this browser. Use Chrome, Edge, or Firefox (desktop or Android).";

  useEffect(() => {
    void isPushSubscribed().then(setSubscribed);
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setError("");
    try {
      if (next) {
        await enablePush();
        setSubscribed(true);
      } else {
        await disablePush();
        setSubscribed(false);
      }
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : "Could not update notifications.",
      );
      setSubscribed(await isPushSubscribed());
    } finally {
      setBusy(false);
    }
  }

  return (
    <StickerPanel
      description="Get a notification on this device when a video finishes translating."
      title="Notifications"
    >
      <FieldGroup>
        <Field orientation="horizontal">
          <div className="flex-1">
            <FieldLabel>Video-ready alerts</FieldLabel>
            <FieldDescription>
              {supported
                ? "A push notification when subtitles are ready — even if the app is closed."
                : unsupportedHint}
            </FieldDescription>
            {error ? (
              <FieldDescription className="font-bold text-vidura-coral">
                {error}
              </FieldDescription>
            ) : null}
          </div>
          <Switch
            checked={subscribed}
            disabled={!supported || busy}
            onCheckedChange={toggle}
          />
        </Field>
      </FieldGroup>
    </StickerPanel>
  );
}

type TranslationSettings = { targetLanguage: string; systemPrompt: string };
const defaultTranslationSettings: TranslationSettings = {
  targetLanguage: "Sinhala",
  systemPrompt: "",
};

function TranslationSettingsPanel() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["translation-settings"],
    queryFn: () =>
      api.get<TranslationSettings>("/api/settings/translation"),
  });
  const [draft, setDraft] = useState<TranslationSettings | null>(null);
  const saveMutation = useMutation({
    mutationFn: (next: TranslationSettings) =>
      api.put<TranslationSettings>("/api/settings/translation", next),
    onSuccess: (saved) => {
      queryClient.setQueryData(["translation-settings"], saved);
      setDraft(saved);
    },
  });

  useEffect(() => {
    if (settingsQuery.data && !draft) setDraft(settingsQuery.data);
  }, [settingsQuery.data, draft]);

  const current = draft ?? settingsQuery.data ?? defaultTranslationSettings;
  const saved = settingsQuery.data ?? defaultTranslationSettings;
  const isDirty = current.targetLanguage !== saved.targetLanguage ||
    current.systemPrompt !== saved.systemPrompt;

  return (
    <StickerPanel
      description="Choose the language new videos are translated into, and optionally customize how the translator writes."
      title="Translation"
    >
      <FieldGroup>
        <Field>
          <FieldLabel>Default translation language</FieldLabel>
          <FieldDescription>
            New videos are translated into this language. Any language works —
            e.g. Sinhala, Italian, German, Tamil.
          </FieldDescription>
          <Input
            className="h-11 border-2 border-foreground bg-card"
            onChange={(event) =>
              setDraft({ ...current, targetLanguage: event.target.value })}
            placeholder="Sinhala"
            value={current.targetLanguage}
          />
        </Field>
        <Field>
          <FieldLabel>Additional translation instructions</FieldLabel>
          <FieldDescription>
            Optional. Added on top of Vidura's built-in translation rules —
            tweak tone, dialect, or terminology. The core rules (whole-video
            context, natural phrasing, keeping technical terms in English) and
            the output format always stay in place and can't be overridden.
          </FieldDescription>
          <Textarea
            className="min-h-32 border-2 border-foreground bg-card"
            maxLength={4000}
            onChange={(event) =>
              setDraft({ ...current, systemPrompt: event.target.value })}
            placeholder="e.g. Prefer warm, conversational phrasing for young learners. Keep physics terms in English."
            value={current.systemPrompt}
          />
        </Field>
        <div className="flex items-center gap-3">
          <CartoonButton
            disabled={!isDirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate(current)}
            type="button"
          >
            {saveMutation.isPending ? "Saving..." : "Save translation settings"}
            <CheckIcon data-icon="inline-end" />
          </CartoonButton>
          {saveMutation.isSuccess && !isDirty ? (
            <span className="text-sm font-bold text-foreground/60">Saved.</span>
          ) : null}
          {saveMutation.isError ? (
            <span className="text-sm font-bold text-vidura-coral">
              Could not save. Try again.
            </span>
          ) : null}
        </div>
      </FieldGroup>
    </StickerPanel>
  );
}

const chatLanguageOptions: Array<{
  value: ChatSettings["responseLanguage"];
  label: string;
}> = [
  { value: "auto", label: "Auto-detect (match my question)" },
  { value: "si", label: "සිංහල — Sinhala (Unicode)" },
  { value: "en", label: "English" },
  { value: "singlish", label: "Singlish (Sinhala in English letters)" },
];

const chatChoiceSets: Array<{
  key: "answerStyle" | "memoryDepth" | "retrievalDepth" | "creativity";
  title: string;
  description: string;
  options: Array<{ value: string; label: string }>;
}> = [
  {
    key: "answerStyle",
    title: "Answer style",
    description: "How long and detailed replies should be.",
    options: [
      { value: "concise", label: "Concise" },
      { value: "balanced", label: "Balanced" },
      { value: "detailed", label: "Detailed" },
    ],
  },
  {
    key: "memoryDepth",
    title: "Conversation memory",
    description: "How much of the current chat the assistant keeps in mind.",
    options: [
      { value: "short", label: "Short" },
      { value: "medium", label: "Medium" },
      { value: "long", label: "Long" },
    ],
  },
  {
    key: "retrievalDepth",
    title: "Retrieval depth",
    description:
      "How many transcript lines the library assistant searches per question.",
    options: [
      { value: "focused", label: "Focused" },
      { value: "standard", label: "Standard" },
      { value: "broad", label: "Broad" },
    ],
  },
  {
    key: "creativity",
    title: "Creativity",
    description: "Lower stays close to the source; higher is more expressive.",
    options: [
      { value: "focused", label: "Focused" },
      { value: "balanced", label: "Balanced" },
      { value: "creative", label: "Creative" },
    ],
  },
];

function ChatSettingsPanel() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: chatSettingsKey,
    queryFn: fetchChatSettings,
  });
  const [draft, setDraft] = useState<ChatSettings | null>(null);
  const saveMutation = useMutation({
    mutationFn: saveChatSettings,
    onSuccess: (_, saved) => {
      queryClient.setQueryData(chatSettingsKey, saved);
    },
  });

  // Seed the editable draft once the saved settings load.
  useEffect(() => {
    if (settingsQuery.data && !draft) {
      setDraft(settingsQuery.data);
    }
  }, [settingsQuery.data, draft]);

  const current = draft ?? settingsQuery.data ?? defaultChatSettings;
  const saved = settingsQuery.data ?? defaultChatSettings;
  const isDirty = draft
    ? (Object.keys(saved) as Array<keyof ChatSettings>).some(
      (key) => draft[key] !== saved[key],
    )
    : false;

  function update<K extends keyof ChatSettings>(
    key: K,
    value: ChatSettings[K],
  ) {
    setDraft({ ...current, [key]: value });
  }

  return (
    <StickerPanel
      description="Control how the AI assistant answers your video and library chats."
      title="Chat assistant"
    >
      <FieldGroup>
        <Field>
          <FieldLabel>Response language</FieldLabel>
          <FieldDescription>
            Force every answer into one language, or let it match your question.
          </FieldDescription>
          <Select
            onValueChange={(value) =>
              update("responseLanguage", value as ChatSettings["responseLanguage"])}
            value={current.responseLanguage}
          >
            <SelectTrigger className="h-11 border-2 border-foreground bg-card">
              <SelectValue placeholder="Select language" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {chatLanguageOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {chatChoiceSets.map((choice) => (
          <FieldSet key={choice.key}>
            <FieldTitle>{choice.title}</FieldTitle>
            <FieldDescription>{choice.description}</FieldDescription>
            <ToggleGroup
              className="justify-start"
              onValueChange={(value) => {
                if (value) {
                  update(
                    choice.key,
                    value as ChatSettings[typeof choice.key],
                  );
                }
              }}
              type="single"
              value={current[choice.key]}
            >
              {choice.options.map((option) => (
                <ToggleGroupItem
                  className="rounded-md border-2 border-foreground bg-card data-[state=on]:bg-vidura-mint"
                  key={option.value}
                  value={option.value}
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
        ))}
        <Field>
          <FieldLabel>Custom instructions</FieldLabel>
          <FieldDescription>
            Give the assistant a persona or rules, e.g. "Explain like I'm 12"
            or "Always add a real-world example."
          </FieldDescription>
          <Textarea
            className="min-h-24 border-2 border-foreground bg-card"
            maxLength={800}
            onChange={(event) =>
              update("customInstructions", event.target.value)}
            placeholder="Optional — shape how the assistant talks to you..."
            value={current.customInstructions}
          />
        </Field>
        <div className="flex items-center gap-3">
          <CartoonButton
            disabled={!isDirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate(current)}
            type="button"
          >
            {saveMutation.isPending ? "Saving..." : "Save chat settings"}
            <CheckIcon data-icon="inline-end" />
          </CartoonButton>
          {saveMutation.isSuccess && !isDirty ? (
            <span className="text-sm font-bold text-foreground/60">Saved.</span>
          ) : null}
          {saveMutation.isError ? (
            <span className="text-sm font-bold text-vidura-coral">
              Could not save. Try again.
            </span>
          ) : null}
        </div>
      </FieldGroup>
    </StickerPanel>
  );
}

export default App;
