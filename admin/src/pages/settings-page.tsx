import * as React from "react"
import {
  BookOpenTextIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  LanguagesIcon,
  LaptopIcon,
  LockIcon,
  MessagesSquareIcon,
  MicIcon,
  PlugIcon,
  RefreshCwIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "cn"

import { Page } from "@/components/site-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { StatStrip } from "@/components/viz"
import { apiUrl, errorMessage } from "@/lib/api"
import { formatBytes, formatDuration, formatMs, timeAgo } from "@/lib/format"
import {
  useAILogout,
  useAIModels,
  useAIStatus,
  useAITest,
  useAppSettings,
  useCancelAILogin,
  useCreatePairingCode,
  useDevices,
  useInstallEngine,
  useRefreshAI,
  useRevokeDevice,
  useStartAILogin,
  useSystem,
  useUpdateSettings,
} from "@/lib/queries"
import type { AIStatus, AITask, Device, Engine, PairingCode } from "@/lib/types"

export function SettingsPage() {
  const system = useSystem()

  return (
    <Page
      crumbs={[{ label: "System" }, { label: "Settings" }]}
      title="Settings"
      description="Where Vidura’s AI and transcription run. Both use accounts and machines you own: no API keys, no paid services."
    >
      <div className="grid gap-3 md:gap-4 lg:grid-cols-2">
        <ChatGPTCard />
        <TranscriptionCard />
      </div>

      <AITasksCard />

      {system.data ? (
        <StatStrip
          stats={[
            {
              label: "Version",
              value: (
                <span className="font-mono">{system.data.server.version}</span>
              ),
              hint: system.data.server.env,
            },
            {
              label: "Up for",
              value: formatDuration(system.data.server.uptimeSec),
              hint: "since the last restart",
            },
            {
              label: "Database",
              value: formatBytes(system.data.database.sizeBytes),
              hint: "SQLite on the data volume",
            },
            {
              label: "API",
              value: (
                <span className="block truncate font-mono text-base">
                  {new URL(apiUrl).host}
                </span>
              ),
              hint: "address the portals and the Mac call",
            },
          ]}
        />
      ) : (
        <Skeleton className="h-20 rounded-xl" />
      )}
    </Page>
  )
}

// --- shared bits ----------------------------------------------------------

function SettingsCard({
  icon,
  title,
  subtitle,
  status,
  footer,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  status: React.ReactNode
  footer: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card className="h-full gap-0 py-0">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-success to-success/70 text-background [&_svg]:size-4">
            {icon}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{title}</span>
            <span className="truncate text-xs text-muted-foreground">
              {subtitle}
            </span>
          </div>
        </div>
        {status}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">{children}</div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/30 px-4 py-2.5">
        {footer}
      </div>
    </Card>
  )
}

function StatusBadge({
  tone,
  children,
}: {
  tone: "success" | "info" | "muted" | "warning"
  children: React.ReactNode
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 gap-1.5 font-mono",
        tone === "success" && "border-success/30 bg-success/10 text-success",
        tone === "info" && "border-dashed border-info/50 text-info",
        tone === "warning" && "border-warning/40 text-warning",
        tone === "muted" && "border-dashed text-muted-foreground"
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "success" && "bg-success",
          tone === "info" && "animate-pulse bg-info",
          tone === "warning" && "bg-warning",
          tone === "muted" && "bg-muted-foreground"
        )}
      />
      {children}
    </Badge>
  )
}

function CopyText({ value, label }: { value: string; label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={() =>
        navigator.clipboard
          .writeText(value)
          .then(() => toast.success("Copied"))
          .catch(() => toast.error("Couldn’t copy"))
      }
    >
      <CopyIcon />
    </Button>
  )
}

function Command({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-1 rounded-lg border bg-background py-1 pr-1 pl-3">
      <code className="flex-1 py-1 font-mono text-xs leading-5 break-all">
        {children}
      </code>
      <CopyText value={children} label="Copy command" />
    </div>
  )
}

/** Re-renders every second, for countdowns. */
function useNow(active: boolean) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return now
}

function remaining(expiresAt: string, now: number) {
  const seconds = Math.max(
    0,
    Math.round((new Date(expiresAt).getTime() - now) / 1000)
  )
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

// --- ChatGPT --------------------------------------------------------------

function ChatGPTCard() {
  const status = useAIStatus()
  const start = useStartAILogin()
  const cancel = useCancelAILogin()
  const logout = useAILogout()
  const test = useAITest()
  const refresh = useRefreshAI()
  const data = status.data

  const badge = !data ? (
    <StatusBadge tone="muted">Checking</StatusBadge>
  ) : data.state === "connected" ? (
    <StatusBadge tone="success">Connected</StatusBadge>
  ) : data.state === "connecting" ? (
    <StatusBadge tone="info">Waiting for code</StatusBadge>
  ) : data.state === "not_installed" ? (
    <StatusBadge tone="warning">CLI missing</StatusBadge>
  ) : (
    <StatusBadge tone="muted">Not connected</StatusBadge>
  )

  let footer: React.ReactNode
  if (data?.state === "connected") {
    footer = (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? <Spinner /> : <RefreshCwIcon />}
          Recheck
        </Button>
        <DisconnectButton
          pending={logout.isPending}
          onConfirm={() =>
            logout.mutate(undefined, {
              onSuccess: () => toast.success("ChatGPT disconnected"),
              onError: (error) => toast.error(errorMessage(error)),
            })
          }
        />
        <Button
          size="sm"
          onClick={() =>
            test.mutate(undefined, {
              onError: (error) => toast.error(errorMessage(error)),
            })
          }
          disabled={test.isPending}
        >
          {test.isPending ? <Spinner /> : <FlaskConicalIcon />}
          {test.isPending ? "Asking ChatGPT…" : "Run a test"}
        </Button>
      </>
    )
  } else if (data?.state === "connecting") {
    footer = (
      <Button
        variant="outline"
        size="sm"
        onClick={() => cancel.mutate()}
        disabled={cancel.isPending}
      >
        Cancel sign-in
      </Button>
    )
  } else {
    footer = (
      <Button
        size="sm"
        disabled={!data || data.state === "not_installed" || start.isPending}
        onClick={() =>
          start.mutate(undefined, {
            onError: (error) => toast.error(errorMessage(error)),
          })
        }
      >
        {start.isPending ? <Spinner /> : <PlugIcon />}
        {start.isPending ? "Starting sign-in…" : "Connect ChatGPT"}
      </Button>
    )
  }

  return (
    <SettingsCard
      icon={<BotIcon />}
      title="ChatGPT subscription"
      subtitle="AI for translation, glossaries and chat"
      status={badge}
      footer={footer}
    >
      {!data ? (
        <Skeleton className="h-40" />
      ) : data.state === "connecting" && data.login ? (
        <DeviceLogin login={data.login} />
      ) : (
        <>
          <p className="text-[13px] text-muted-foreground">
            Every AI task runs through the Codex CLI signed in to your ChatGPT
            account, as in Thulawa. Usage counts against your plan; no API key
            is involved.
          </p>
          {data.state === "not_installed" && (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>
                The Codex CLI isn’t installed on the server
              </AlertTitle>
              <AlertDescription>
                Install it with{" "}
                <code className="font-mono">npm i -g @openai/codex</code>, then
                reload this page.
              </AlertDescription>
            </Alert>
          )}
          {data.lastError && data.state === "not_connected" && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>Sign-in didn’t finish</AlertTitle>
              <AlertDescription>{data.lastError}</AlertDescription>
            </Alert>
          )}
          <ItemGroup className="gap-0 rounded-lg border has-data-[size=sm]:gap-0 has-data-[size=xs]:gap-0">
            <Fact
              title="Account"
              description="Whose plan is used"
              value={
                data.account?.email ? (
                  <span className="font-mono text-xs">
                    {data.account.email}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              }
            />
            <ItemSeparator className="my-0" />
            <Fact
              title="Plan"
              description="From your ChatGPT account"
              value={
                data.account?.plan ? (
                  <Badge variant="secondary" className="font-mono capitalize">
                    {data.account.plan}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              }
            />
            <ItemSeparator className="my-0" />
            <Fact
              title="Codex CLI"
              description="Runs each task in a read-only sandbox"
              value={
                data.cli.installed ? (
                  <span className="flex items-center gap-1 font-mono text-xs text-success">
                    <CheckIcon className="size-3.5" />v{data.cli.version || "?"}
                  </span>
                ) : (
                  <span className="text-xs text-warning">Not installed</span>
                )
              }
            />
            <ItemSeparator className="my-0" />
            <Fact
              title="Used for"
              description="Every AI step"
              value={
                <span className="flex gap-1">
                  {["translate", "glossary", "chat"].map((task) => (
                    <Badge key={task} variant="secondary" className="font-mono">
                      {task}
                    </Badge>
                  ))}
                </span>
              }
            />
          </ItemGroup>
          {test.data && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-[13px]">
              <span className="flex items-center gap-2">
                <CheckIcon className="size-4 text-success" />
                ChatGPT replied “{test.data.reply}”
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {formatMs(test.data.durationMs)}
              </span>
            </div>
          )}
        </>
      )}
    </SettingsCard>
  )
}

function Fact({
  title,
  description,
  value,
}: {
  title: string
  description: string
  value: React.ReactNode
}) {
  return (
    <Item size="xs" className="px-3 py-2">
      <ItemContent className="gap-0">
        <ItemTitle className="text-[13px]">{title}</ItemTitle>
        <ItemDescription className="text-xs">{description}</ItemDescription>
      </ItemContent>
      <ItemActions>{value}</ItemActions>
    </Item>
  )
}

function DeviceLogin({ login }: { login: NonNullable<AIStatus["login"]> }) {
  const now = useNow(true)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">
        Sign in to ChatGPT in your browser and enter this code. This page
        updates by itself once you approve it.
      </p>
      <div className="flex flex-col items-center gap-1.5 rounded-xl border bg-background px-4 py-5">
        <span className="text-xs text-muted-foreground">One-time code</span>
        <div className="flex items-center gap-1">
          <span className="font-mono text-3xl tracking-[0.2em]">
            {login.code}
          </span>
          <CopyText value={login.code} label="Copy code" />
        </div>
        <span className="tabular font-mono text-xs text-muted-foreground">
          expires in {remaining(login.expiresAt, now)}
        </span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button asChild size="sm">
          <a href={login.url} target="_blank" rel="noreferrer noopener">
            <ExternalLinkIcon />
            Open the sign-in page
          </a>
        </Button>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Waiting for approval
        </span>
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">
        {login.url}
      </p>
      <p className="text-xs text-muted-foreground">
        Only enter the code if you started this sign-in here.
      </p>
    </div>
  )
}

function DisconnectButton({
  pending,
  onConfirm,
}: {
  pending: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending}>
          <UnplugIcon />
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect ChatGPT?</AlertDialogTitle>
          <AlertDialogDescription>
            The server signs out of your ChatGPT account. Translation and chat
            stop until you connect again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep connected</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// --- transcription Mac ----------------------------------------------------

const engines: Array<{
  id: Engine
  name: string
  runtime: string
  note: string
}> = [
  {
    id: "parakeet",
    name: "Parakeet TDT 0.6B v2",
    runtime: "MLX",
    note: "Fastest, with word timings · ~2.5 GB",
  },
  {
    id: "phonon",
    name: "Phonon-2",
    runtime: "Core ML",
    note: "Being benchmarked; no installer yet",
  },
  {
    id: "whisper",
    name: "Whisper large-v3-turbo",
    runtime: "MLX",
    note: "Best with noisy audio · ~1.6 GB",
  },
]

function TranscriptionCard() {
  const [pairing, setPairing] = React.useState(false)
  const devices = useDevices(pairing)
  const settings = useAppSettings()
  const update = useUpdateSettings()
  const list = devices.data ?? []
  const online = list.filter((d) => d.online)
  const mac = online[0]

  const badge =
    online.length > 0 ? (
      <StatusBadge tone="success">{online.length} online</StatusBadge>
    ) : list.length > 0 ? (
      <StatusBadge tone="warning">Offline</StatusBadge>
    ) : (
      <StatusBadge tone="muted">No Mac paired</StatusBadge>
    )

  return (
    <SettingsCard
      icon={<LaptopIcon />}
      title="Transcription Mac"
      subtitle="Speech to text when a video has no captions"
      status={badge}
      footer={
        <Button size="sm" onClick={() => setPairing(true)}>
          <PlugIcon />
          Pair a Mac
        </Button>
      }
    >
      {devices.isPending ? (
        <Skeleton className="h-24" />
      ) : list.length === 0 ? (
        <>
          <p className="text-[13px] text-muted-foreground">
            Your always-on Mac transcribes videos that have no YouTube captions.
            It connects out to the server, so nothing on the Mac is opened to
            the internet, and it accepts only fixed jobs.
          </p>
          <SecureLink />
        </>
      ) : (
        <ItemGroup className="gap-0 rounded-lg border has-data-[size=sm]:gap-0 has-data-[size=xs]:gap-0">
          {list.map((device, index) => (
            <React.Fragment key={device.id}>
              {index > 0 && <ItemSeparator className="my-0" />}
              <DeviceRow device={device} />
            </React.Fragment>
          ))}
        </ItemGroup>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium">Speech models</span>
          <span className="text-xs text-muted-foreground">
            {mac ? `on ${mac.name}` : "pair and start a Mac to download"}
          </span>
        </div>
        <div className="overflow-hidden rounded-lg border">
          {engines.map((engine, index) => (
            <EngineRow
              key={engine.id}
              engine={engine}
              device={mac}
              selected={settings.data?.asrEngine === engine.id}
              className={cn(index > 0 && "border-t")}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
        <Label
          htmlFor="mac-fallback"
          className="flex flex-col items-start gap-0 font-normal"
        >
          <span className="text-[13px]">
            Send caption-less videos to the Mac
          </span>
          <span className="text-xs text-muted-foreground">
            Off: those videos fail with “no captions”
          </span>
        </Label>
        <Switch
          id="mac-fallback"
          checked={settings.data?.asrFallback ?? true}
          disabled={!settings.data || update.isPending}
          onCheckedChange={(checked) =>
            update.mutate(
              { asrFallback: checked },
              {
                onSuccess: () => toast.success("Saved"),
                onError: (error) => toast.error(errorMessage(error)),
              }
            )
          }
        />
      </div>

      <PairDialog open={pairing} onOpenChange={setPairing} devices={list} />
    </SettingsCard>
  )
}

/** One speech model: its state on the Mac and a download button. */
function EngineRow({
  engine,
  device,
  selected,
  className,
}: {
  engine: (typeof engines)[number]
  device: Device | undefined
  selected: boolean
  className?: string
}) {
  const install = useInstallEngine()
  const reported = device?.capabilities?.engines.find((e) => e.id === engine.id)
  const progress = device?.installs?.[engine.id]
  const busy =
    install.isPending ||
    progress?.state === "queued" ||
    progress?.state === "installing"
  const ready = reported?.ready ?? false
  const noInstaller = engine.id === "phonon"

  let status: React.ReactNode
  if (!device)
    status = <span className="text-xs text-muted-foreground">Mac offline</span>
  else if (busy)
    status = (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-info">
        <Spinner className="size-3.5 shrink-0" />
        <span className="truncate">{progress?.detail || "Starting…"}</span>
      </span>
    )
  else if (ready)
    status = (
      <span className="flex items-center gap-1 text-xs text-success">
        <CheckIcon className="size-3.5" />
        Downloaded
      </span>
    )
  else if (progress?.state === "failed")
    status = (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="truncate text-xs text-failure">Failed</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{progress.detail}</TooltipContent>
      </Tooltip>
    )
  else
    status = (
      <span className="truncate text-xs text-muted-foreground">
        {reported?.detail ?? "not installed"}
      </span>
    )

  return (
    <div className={cn("flex items-center gap-3 px-3 py-2", className)}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="font-mono text-[13px]">{engine.name}</span>
          {selected && (
            <Badge variant="outline" className="border-success/30 text-success">
              in use
            </Badge>
          )}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {engine.note}
        </span>
      </div>
      <div className="flex max-w-[45%] min-w-0 items-center justify-end gap-2">
        {status}
        <Badge variant="secondary" className="shrink-0 font-mono">
          {engine.runtime}
        </Badge>
        {device && !ready && !noInstaller && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            disabled={busy}
            onClick={() =>
              install.mutate(
                { device: device.id, engine: engine.id },
                {
                  onSuccess: () =>
                    toast.success(
                      `Downloading ${engine.name} on ${device.name}`
                    ),
                  onError: (error) => toast.error(errorMessage(error)),
                }
              )
            }
          >
            <DownloadIcon />
            {progress?.state === "failed" ? "Retry" : "Download"}
          </Button>
        )}
      </div>
    </div>
  )
}

// --- AI tasks -------------------------------------------------------------

const aiTasks: Array<{
  id: AITask
  name: string
  description: string
  icon: React.ReactNode
}> = [
  {
    id: "summary",
    name: "Summary & glossary",
    description: "Topic, summary, audience and key terms before translating",
    icon: <BookOpenTextIcon />,
  },
  {
    id: "translate",
    name: "Translation",
    description: "English lines into Sinhala, in windows",
    icon: <LanguagesIcon />,
  },
  {
    id: "chat",
    name: "Chat",
    description: "Answers about a video in the Vidura app",
    icon: <MessagesSquareIcon />,
  },
]

const effortLabels: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
}

function AITasksCard() {
  const ai = useAIStatus()
  const models = useAIModels(Boolean(ai.data?.cli.installed))
  const settings = useAppSettings()
  const update = useUpdateSettings()
  const list = models.data ?? []

  const save = (change: Parameters<typeof update.mutate>[0], label: string) =>
    update.mutate(change, {
      onSuccess: () => toast.success(`${label} saved`),
      onError: (error) => toast.error(errorMessage(error)),
    })

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-success to-success/70 text-background [&_svg]:size-4">
            <SlidersHorizontalIcon />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">AI tasks</span>
            <span className="truncate text-xs text-muted-foreground">
              Which model and how much reasoning each step uses
            </span>
          </div>
        </div>
        {ai.data?.state !== "connected" && (
          <StatusBadge tone="muted">ChatGPT not connected</StatusBadge>
        )}
      </div>
      <div className="divide-y">
        <div className="grid items-center gap-3 px-4 py-2.5 md:grid-cols-[minmax(0,1fr)_220px_160px]">
          <TaskLabel
            icon={<MicIcon />}
            name="Transcription"
            description="Speech to text on your Mac, for videos without captions"
          />
          <Select
            value={settings.data?.asrEngine}
            onValueChange={(value) =>
              save({ asrEngine: value as Engine }, "Transcription engine")
            }
            disabled={!settings.data || update.isPending}
          >
            <SelectTrigger size="sm" className="w-full font-mono text-xs">
              <SelectValue placeholder="Engine" />
            </SelectTrigger>
            <SelectContent>
              {engines.map((engine) => (
                <SelectItem
                  key={engine.id}
                  value={engine.id}
                  className="font-mono text-xs"
                >
                  {engine.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground md:text-right">
            runs on the Mac
          </span>
        </div>
        {aiTasks.map((task) => {
          const current = settings.data?.ai[task.id]
          const model = list.find((m) => m.slug === current?.model)
          const efforts = model?.efforts ?? (current ? [current.effort] : [])
          return (
            <div
              key={task.id}
              className="grid items-center gap-3 px-4 py-2.5 md:grid-cols-[minmax(0,1fr)_220px_160px]"
            >
              <TaskLabel
                icon={task.icon}
                name={task.name}
                description={task.description}
              />
              <Select
                value={current?.model}
                onValueChange={(slug) => {
                  const next = list.find((m) => m.slug === slug)
                  if (!next) return
                  const effort = next.efforts.includes(current?.effort ?? "")
                    ? current!.effort
                    : next.defaultEffort || next.efforts[0]
                  save(
                    { ai: { [task.id]: { model: slug, effort } } },
                    task.name
                  )
                }}
                disabled={
                  !settings.data || list.length === 0 || update.isPending
                }
              >
                <SelectTrigger size="sm" className="w-full font-mono text-xs">
                  <SelectValue
                    placeholder={models.isPending ? "Loading models…" : "Model"}
                  >
                    {model?.name ?? current?.model}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {list.map((m) => (
                    <SelectItem key={m.slug} value={m.slug}>
                      <span className="flex flex-col">
                        <span className="font-mono text-xs">{m.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {m.description}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={current?.effort}
                onValueChange={(effort) =>
                  current &&
                  save(
                    { ai: { [task.id]: { model: current.model, effort } } },
                    task.name
                  )
                }
                disabled={!settings.data || !model || update.isPending}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue placeholder="Effort" />
                </SelectTrigger>
                <SelectContent>
                  {efforts.map((effort) => (
                    <SelectItem key={effort} value={effort} className="text-xs">
                      {effortLabels[effort] ?? effort}
                      {model?.defaultEffort === effort && (
                        <span className="text-muted-foreground">
                          {" "}
                          · default
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        })}
      </div>
      {models.isError && (
        <p className="border-t px-4 py-2 text-xs text-failure">
          Couldn’t read the model list from the Codex CLI:{" "}
          {errorMessage(models.error)}
        </p>
      )}
    </Card>
  )
}

function TaskLabel({
  icon,
  name,
  description,
}: {
  icon: React.ReactNode
  name: string
  description: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border text-muted-foreground [&_svg]:size-3.5">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px]">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {description}
        </span>
      </div>
    </div>
  )
}

function DeviceRow({ device }: { device: Device }) {
  const revoke = useRevokeDevice()
  const caps = device.capabilities
  return (
    <Item size="xs" className="items-start px-3 py-2.5">
      <ItemMedia className="pt-1.5">
        <span
          className={cn(
            "size-2 rounded-full",
            device.online
              ? "bg-success shadow-[0_0_0_3px] shadow-success/20"
              : "bg-muted-foreground/50"
          )}
        />
      </ItemMedia>
      <ItemContent className="gap-1">
        <ItemTitle className="text-[13px]">
          {device.name}
          <span className="font-normal text-muted-foreground">
            {device.online
              ? "online"
              : `last seen ${timeAgo(device.lastSeenAt)}`}
          </span>
        </ItemTitle>
        <ItemDescription className="font-mono text-xs">
          {device.hostname || "unknown host"} · {device.platform || "?"} · agent{" "}
          {device.agentVersion || "?"}
        </ItemDescription>
        {caps && (
          <div className="flex flex-wrap gap-1">
            {caps.engines.map((engine) => (
              <Tooltip key={engine.id}>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-mono",
                      engine.ready
                        ? "border-success/30 text-success"
                        : "border-dashed text-muted-foreground"
                    )}
                  >
                    {engine.ready && <CheckIcon />}
                    {engine.id}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{engine.detail}</TooltipContent>
              </Tooltip>
            ))}
            {Object.entries(caps.tools).map(([tool, ok]) => (
              <Badge
                key={tool}
                variant="outline"
                className={cn(
                  "font-mono",
                  ok ? "text-foreground" : "border-dashed text-warning"
                )}
              >
                {tool}
                {!ok && " missing"}
              </Badge>
            ))}
          </div>
        )}
      </ItemContent>
      <ItemActions>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={revoke.isPending}>
              Revoke
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {device.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Its connection drops now and its key stops working. To use this
                Mac again, pair it with a new code.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() =>
                  revoke.mutate(device.id, {
                    onSuccess: () => toast.success(`${device.name} revoked`),
                    onError: (error) => toast.error(errorMessage(error)),
                  })
                }
              >
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
    </Item>
  )
}

function PairDialog({
  open,
  onOpenChange,
  devices,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  devices: Device[]
}) {
  const { mutate } = useCreatePairingCode()
  const [code, setCode] = React.useState<PairingCode | null>(null)
  const [known, setKnown] = React.useState<Set<string> | null>(null)
  const now = useNow(open && code !== null)

  // A fresh code each time the dialog opens. The devices that exist at
  // that moment are remembered, so the dialog can spot the new one.
  const openDialog = (next: boolean) => {
    onOpenChange(next)
  }
  React.useEffect(() => {
    if (!open) return
    mutate(undefined, {
      onSuccess: setCode,
      onError: (error) => toast.error(errorMessage(error)),
    })
  }, [open, mutate])
  if (open && known === null) setKnown(new Set(devices.map((d) => d.id)))
  if (!open && (known !== null || code !== null)) {
    setKnown(null)
    setCode(null)
  }

  const paired = known ? devices.find((d) => !known.has(d.id)) : undefined
  const expired = code
    ? new Date(code.pairing.expiresAt).getTime() <= now
    : false

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pair a Mac</DialogTitle>
          <DialogDescription>
            Run these in a terminal on the Mac, from the Vidura repository. The
            code works once, for ten minutes.
          </DialogDescription>
        </DialogHeader>

        {paired ? (
          <Alert>
            <CheckIcon />
            <AlertTitle>{paired.name} is paired</AlertTitle>
            <AlertDescription>
              {paired.online
                ? "It’s connected and reporting its engines."
                : "Start it with the run command to bring it online."}
            </AlertDescription>
          </Alert>
        ) : !code ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-xl border bg-background px-4 py-3">
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">
                  Pairing code
                </span>
                <span
                  className={cn(
                    "font-mono text-2xl tracking-[0.2em]",
                    expired && "text-muted-foreground line-through"
                  )}
                >
                  {code.pairing.code}
                </span>
              </div>
              <span className="tabular font-mono text-xs text-muted-foreground">
                {expired
                  ? "expired"
                  : `expires in ${remaining(code.pairing.expiresAt, now)}`}
              </span>
            </div>
            <Step n={1} label="Build the agent">
              <Command>make agent</Command>
            </Step>
            <Step n={2} label="Pair this Mac">
              <Command>{`backend/bin/vidura-agent pair --server ${code.serverUrl} --code ${code.pairing.code}`}</Command>
            </Step>
            <Step n={3} label="Keep it running">
              <Command>backend/bin/vidura-agent run</Command>
            </Step>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Waiting for the Mac to pair…
            </p>
          </div>
        )}

        <DialogFooter>
          {expired && !paired && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => mutate(undefined, { onSuccess: setCode })}
            >
              New code
            </Button>
          )}
          <Button
            size="sm"
            variant={paired ? "default" : "outline"}
            onClick={() => onOpenChange(false)}
          >
            {paired ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Step({
  n,
  label,
  children,
}: {
  n: number
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-[13px]">
        <span className="flex size-4 items-center justify-center rounded-full border font-mono text-[10px] text-muted-foreground">
          {n}
        </span>
        {label}
      </span>
      {children}
    </div>
  )
}

/** Server → encrypted, outbound-only link → Mac. */
function SecureLink() {
  const node = (icon: React.ReactNode, label: string, sub: string) => (
    <div className="flex flex-col items-center gap-1">
      <span className="flex size-9 items-center justify-center rounded-lg border bg-background text-success [&_svg]:size-4">
        {icon}
      </span>
      <span className="text-xs">{label}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{sub}</span>
    </div>
  )
  return (
    <div className="rounded-lg border bg-muted/20 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        {node(<ServerIcon />, "Vidura server", "vps")}
        <div className="mt-4 flex flex-1 items-center gap-2">
          <span className="h-px flex-1 border-t border-dashed border-success/60" />
          <span className="flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            <LockIcon className="size-3" />
            wss · device key
          </span>
          <span className="h-px flex-1 border-t border-dashed border-success/60" />
        </div>
        {node(<LaptopIcon />, "Your Mac", "outbound only")}
      </div>
    </div>
  )
}
