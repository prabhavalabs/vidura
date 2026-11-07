import * as React from "react"
import {
  CaptionsIcon,
  CaptionsOffIcon,
  ExternalLinkIcon,
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  PlayIcon,
  Settings2Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"
import { cn } from "cn"

import { Caption } from "@/components/caption"
import { CaptionSettings } from "@/components/caption-settings"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Slider } from "@/components/ui/slider"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { clock } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { setPrefs, usePrefs } from "@/lib/prefs"
import { lineAt } from "@/lib/segments"
import type { Segment } from "@/lib/types"
import {
  embedBlocked,
  loadYouTube,
  PlayerState,
  type YTPlayer,
} from "@/lib/youtube"

/** Controls the watch page uses. */
export type PlayerHandle = {
  seek: (ms: number) => void
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const HIDE_AFTER_MS = 2500
const TICK_MS = 200

type Status = "loading" | "ready" | "blocked"
type Fullscreen = "off" | "native" | "css"

/**
 * Vidura's video player: YouTube's player with its own controls and
 * subtitles turned off, our controls, and our subtitles drawn on top.
 */
export const Player = React.forwardRef<
  PlayerHandle,
  {
    youtubeId: string
    youtubeUrl: string
    thumbnailUrl: string | null
    segments: Segment[]
    /** Called with the playback time, about five times a second. */
    onTime: (ms: number) => void
    /** Where playback starts, e.g. from a link to a moment in the video. */
    startMs?: number
    className?: string
  }
>(function Player(
  {
    youtubeId,
    youtubeUrl,
    thumbnailUrl,
    segments,
    onTime,
    startMs = 0,
    className,
  },
  ref
) {
  const t = useT()
  const prefs = usePrefs()
  const frame = React.useRef<HTMLDivElement>(null)
  const shell = React.useRef<HTMLDivElement | null>(null)
  // The same element, as state, so full-screen menus can render inside it.
  const [shellElement, setShellElement] = React.useState<HTMLDivElement | null>(
    null
  )
  const player = React.useRef<YTPlayer | null>(null)
  const onTimeRef = React.useRef(onTime)
  React.useEffect(() => {
    onTimeRef.current = onTime
  })

  const [status, setStatus] = React.useState<Status>("loading")
  const [playing, setPlaying] = React.useState(false)
  const [buffering, setBuffering] = React.useState(false)
  const [started, setStarted] = React.useState(false)
  const [timeMs, setTimeMs] = React.useState(startMs)
  const startRef = React.useRef(startMs)
  const [durationMs, setDurationMs] = React.useState(0)
  const [scrubMs, setScrubMs] = React.useState<number | null>(null)
  const [muted, setMuted] = React.useState(false)
  const [volume, setVolume] = React.useState(100)
  const [rate, setRate] = React.useState(1)
  const [fullscreen, setFullscreen] = React.useState<Fullscreen>("off")
  const [controlsShown, setControlsShown] = React.useState(true)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const hideTimer = React.useRef<number | undefined>(undefined)

  const readTime = React.useCallback(() => {
    const p = player.current
    if (!p) return
    const ms = Math.round(p.getCurrentTime() * 1000)
    setTimeMs(ms)
    onTimeRef.current(ms)
    const total = Math.round(p.getDuration() * 1000)
    if (total > 0) setDurationMs(total)
  }, [])

  // Show the controls, then hide them again while the video plays.
  const poke = React.useCallback(() => {
    setControlsShown(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (player.current?.getPlayerState() === PlayerState.playing) {
        setControlsShown(false)
      }
    }, HIDE_AFTER_MS)
  }, [])

  // Create the YouTube player and follow its state.
  React.useEffect(() => {
    let cancelled = false
    let ticker: number | undefined
    loadYouTube()
      .then((YT) => {
        if (cancelled || !frame.current) return
        const mount = document.createElement("div")
        frame.current.replaceChildren(mount)
        player.current = new YT.Player(mount, {
          host: "https://www.youtube-nocookie.com",
          videoId: youtubeId,
          width: "100%",
          height: "100%",
          playerVars: {
            controls: 0, // our own controls
            disablekb: 1, // our own keyboard shortcuts
            fs: 0, // our own full screen keeps the subtitles on screen
            cc_load_policy: 0, // no YouTube subtitles: ours replace them
            iv_load_policy: 3,
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            start: Math.floor(startRef.current / 1000),
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (cancelled) return
              setStatus("ready")
              player.current?.unloadModule("captions")
              readTime()
              // Before the first play YouTube reports 0, not the start.
              if (startRef.current > 0) {
                setTimeMs(startRef.current)
                onTimeRef.current(startRef.current)
              }
            },
            onError: (event) => {
              if (!cancelled && embedBlocked.has(event.data))
                setStatus("blocked")
            },
            onStateChange: (event) => {
              if (cancelled) return
              const state = event.data
              window.clearInterval(ticker)
              setPlaying(state === PlayerState.playing)
              setBuffering(state === PlayerState.buffering)
              if (state === PlayerState.playing) {
                setStarted(true)
                poke()
                // YouTube can bring its subtitles back when playback starts.
                player.current?.unloadModule("captions")
                ticker = window.setInterval(readTime, TICK_MS)
              }
              readTime()
            },
          },
        })
      })
      .catch(() => !cancelled && setStatus("blocked"))
    return () => {
      cancelled = true
      window.clearInterval(ticker)
      player.current?.destroy()
      player.current = null
    }
  }, [youtubeId, readTime, poke])

  const seek = React.useCallback(
    (ms: number) => {
      const p = player.current
      if (!p) return
      const target = Math.max(0, durationMs ? Math.min(ms, durationMs) : ms)
      p.seekTo(target / 1000, true)
      setTimeMs(target)
      onTimeRef.current(target)
    },
    [durationMs]
  )

  React.useImperativeHandle(ref, () => ({
    seek: (ms) => {
      seek(ms)
      player.current?.playVideo()
    },
  }))

  const togglePlay = React.useCallback(() => {
    const p = player.current
    if (!p) return
    if (p.getPlayerState() === PlayerState.playing) p.pauseVideo()
    else p.playVideo()
  }, [])

  const toggleMute = React.useCallback(() => {
    const p = player.current
    if (!p) return
    if (p.isMuted()) {
      p.unMute()
      setMuted(false)
    } else {
      p.mute()
      setMuted(true)
    }
  }, [])

  const toggleFullscreen = React.useCallback(async () => {
    if (document.fullscreenElement) return document.exitFullscreen()
    if (fullscreen === "css") return setFullscreen("off")
    try {
      await shell.current?.requestFullscreen()
    } catch {
      // iPhones can't make a page element fullscreen: fill the window.
      setFullscreen("css")
    }
  }, [fullscreen])

  React.useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  // Follow the browser's full screen; Escape leaves our CSS full screen.
  React.useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement ? "native" : "off")
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  // Keyboard shortcuts, unless the reader is typing somewhere.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest(
          "input, textarea, select, [contenteditable], [role=dialog], [role=menu]"
        )
      )
        return
      const now = Math.round((player.current?.getCurrentTime() ?? 0) * 1000)
      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault()
          togglePlay()
          break
        case "ArrowLeft":
        case "j":
          event.preventDefault()
          seek(now - (event.key === "j" ? 10_000 : 5_000))
          break
        case "ArrowRight":
        case "l":
          event.preventDefault()
          seek(now + (event.key === "l" ? 10_000 : 5_000))
          break
        case "m":
          toggleMute()
          break
        case "c":
          setPrefs({ captions: !prefs.captions })
          break
        case "f":
          void toggleFullscreen()
          break
        case "Escape":
          setFullscreen((f) => (f === "css" ? "off" : f))
          break
        default:
          return
      }
      poke()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [togglePlay, toggleMute, toggleFullscreen, seek, poke, prefs.captions])

  // Taps on the video: one tap shows the controls (or plays/pauses when
  // they're showing); a double tap on either side skips 10 seconds.
  const lastTap = React.useRef(0)
  const tapTimer = React.useRef<number | undefined>(undefined)
  function onSurfaceClick(event: React.MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const now = Date.now()
    if (now - lastTap.current < 300) {
      window.clearTimeout(tapTimer.current)
      lastTap.current = 0
      const current = Math.round((player.current?.getCurrentTime() ?? 0) * 1000)
      if (x < 0.35) seek(current - 10_000)
      else if (x > 0.65) seek(current + 10_000)
      else void toggleFullscreen()
      poke()
      return
    }
    lastTap.current = now
    const wasShown = controlsShown
    tapTimer.current = window.setTimeout(() => {
      const coarse = window.matchMedia("(pointer: coarse)").matches
      if (coarse && !wasShown) poke()
      else togglePlay()
    }, 220)
  }

  const shownMs = scrubMs ?? timeMs
  const index = lineAt(segments, shownMs)
  const line =
    index >= 0 && shownMs <= segments[index].endMs + 400
      ? segments[index]
      : null
  const isFull = fullscreen !== "off"
  const overlay = isFull || prefs.placement === "overlay"
  const showControls = controlsShown || !playing || menuOpen
  // Keep overlay subtitles clear of the control bar while it shows.
  const captionBottom = `calc(${prefs.position}% + ${showControls ? "3.75rem" : "0.75rem"})`

  return (
    <div
      ref={(element) => {
        shell.current = element
        setShellElement(element)
      }}
      className={cn(
        "group/player flex flex-col overflow-hidden bg-black select-none",
        isFull ? "justify-center" : cn("rounded-xl", className),
        fullscreen === "css" && "fixed inset-0 z-50 rounded-none"
      )}
      onMouseMove={poke}
    >
      <div
        className={cn(
          "relative w-full",
          isFull ? "h-full max-h-svh" : "aspect-video",
          !showControls && "cursor-none"
        )}
      >
        <div
          ref={frame}
          className="pointer-events-none absolute inset-0 [&_iframe]:size-full"
          aria-hidden
        />

        {/* Our surface over the video: taps and clicks. */}
        {status === "ready" && (
          <div
            className="absolute inset-0"
            onClick={onSurfaceClick}
            role="presentation"
          />
        )}

        {/* Before the first play: the thumbnail and a big play button. */}
        {!started && status !== "blocked" && (
          <button
            type="button"
            className="group/play absolute inset-0 flex items-center justify-center bg-black outline-none"
            onClick={() => player.current?.playVideo()}
            disabled={status !== "ready"}
            aria-label={t.player.play}
          >
            {thumbnailUrl && (
              <img
                src={thumbnailUrl}
                alt=""
                className="absolute inset-0 size-full object-cover opacity-80"
              />
            )}
            <span className="relative flex size-16 items-center justify-center rounded-full bg-white text-black shadow-lg transition-transform duration-150 ease-out group-hover/play:scale-105 group-focus-visible/play:ring-4 group-focus-visible/play:ring-white/50 group-active/play:scale-95 sm:size-20">
              {status === "loading" ? (
                <Spinner className="size-7" />
              ) : (
                <PlayIcon className="ml-1 size-8 fill-current" />
              )}
            </span>
          </button>
        )}

        {started && buffering && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Spinner className="size-8 text-white" />
          </div>
        )}

        {status === "blocked" && (
          <Empty className="absolute inset-0 bg-black text-white">
            <EmptyHeader>
              <EmptyTitle>{t.player.blockedTitle}</EmptyTitle>
              <EmptyDescription className="text-white/70">
                {t.player.blockedBody}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="secondary" asChild>
                <a href={youtubeUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon />
                  {t.player.openYouTube}
                </a>
              </Button>
            </EmptyContent>
          </Empty>
        )}

        {overlay && prefs.captions && line && started && (
          <div
            className="pointer-events-none absolute inset-x-0 flex justify-center px-3 transition-[bottom] duration-200"
            style={{ bottom: captionBottom }}
          >
            <Caption
              sinhala={line.translation}
              english={line.text}
              prefs={prefs}
            />
          </div>
        )}

        {started && status === "ready" && (
          <Controls
            visible={showControls}
            playing={playing}
            timeMs={shownMs}
            durationMs={durationMs}
            muted={muted}
            volume={volume}
            rate={rate}
            fullscreen={isFull}
            captions={prefs.captions}
            onTogglePlay={togglePlay}
            onScrub={setScrubMs}
            onSeek={(ms) => {
              setScrubMs(null)
              seek(ms)
            }}
            onToggleMute={toggleMute}
            onVolume={(value) => {
              player.current?.setVolume(value)
              if (value > 0 && muted) {
                player.current?.unMute()
                setMuted(false)
              }
              setVolume(value)
            }}
            onRate={(value) => {
              player.current?.setPlaybackRate(value)
              setRate(value)
            }}
            onToggleCaptions={() => setPrefs({ captions: !prefs.captions })}
            onToggleFullscreen={() => void toggleFullscreen()}
            onMenuOpen={setMenuOpen}
            container={isFull ? shellElement : null}
          />
        )}
      </div>

      {!overlay && prefs.captions && (
        <div className="flex min-h-20 items-center justify-center px-3 py-3">
          {line && started ? (
            <Caption
              sinhala={line.translation}
              english={line.text}
              prefs={prefs}
            />
          ) : null}
        </div>
      )}
    </div>
  )
})

/**
 * A hover label for a control, with its keyboard shortcut. Touch screens
 * don't hover, so phones never see these.
 */
function Tip({
  label,
  keys,
  container,
  children,
}: {
  label: string
  keys?: string
  container: HTMLElement | null
  children: React.ReactNode
}) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent container={container} sideOffset={6}>
        {label}
        {keys && <Kbd>{keys}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

function Controls({
  visible,
  playing,
  timeMs,
  durationMs,
  muted,
  volume,
  rate,
  fullscreen,
  captions,
  onTogglePlay,
  onScrub,
  onSeek,
  onToggleMute,
  onVolume,
  onRate,
  onToggleCaptions,
  onToggleFullscreen,
  onMenuOpen,
  container,
}: {
  visible: boolean
  playing: boolean
  timeMs: number
  durationMs: number
  muted: boolean
  volume: number
  rate: number
  fullscreen: boolean
  captions: boolean
  onTogglePlay: () => void
  onScrub: (ms: number) => void
  onSeek: (ms: number) => void
  onToggleMute: () => void
  onVolume: (volume: number) => void
  onRate: (rate: number) => void
  onToggleCaptions: () => void
  onToggleFullscreen: () => void
  onMenuOpen: (open: boolean) => void
  /** In full screen, menus open inside the player so they stay visible. */
  container: HTMLElement | null
}) {
  const t = useT()
  const iconButton =
    "text-white hover:bg-white/15 hover:text-white focus-visible:ring-white/50 active:scale-95"
  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2 pt-8 pb-1.5 text-white transition-opacity duration-200 sm:px-3",
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <Slider
        min={0}
        max={Math.max(durationMs, 1)}
        step={1000}
        value={[Math.min(timeMs, durationMs || timeMs)]}
        onValueChange={([ms]) => onScrub(ms)}
        onValueCommit={([ms]) => onSeek(ms)}
        aria-label={t.player.seek}
        className="py-2 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-track]]:bg-white/25"
      />
      <div className="flex items-center gap-0.5">
        <Tip
          label={playing ? t.player.pause : t.player.play}
          keys="K"
          container={container}
        >
          <Button
            size="icon"
            variant="ghost"
            className={iconButton}
            onClick={onTogglePlay}
            aria-label={playing ? t.player.pause : t.player.play}
          >
            {playing ? (
              <PauseIcon className="fill-current" />
            ) : (
              <PlayIcon className="fill-current" />
            )}
          </Button>
        </Tip>
        <Tip
          label={muted ? t.player.unmute : t.player.mute}
          keys="M"
          container={container}
        >
          <Button
            size="icon"
            variant="ghost"
            className={iconButton}
            onClick={onToggleMute}
            aria-label={muted ? t.player.unmute : t.player.mute}
          >
            {muted || volume === 0 ? <VolumeXIcon /> : <Volume2Icon />}
          </Button>
        </Tip>
        <Slider
          min={0}
          max={100}
          step={5}
          value={[muted ? 0 : volume]}
          onValueChange={([value]) => onVolume(value)}
          aria-label={t.player.volume}
          className="hidden w-20 sm:flex [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-track]]:bg-white/25"
        />
        <span className="ml-2 text-xs text-white/90 tabular-nums sm:text-sm">
          {clock(timeMs)} / {clock(durationMs)}
        </span>
        <div className="flex-1" />
        <DropdownMenu onOpenChange={onMenuOpen}>
          <Tip label={t.player.speed} container={container}>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className={cn(iconButton, "px-2 tabular-nums")}
                aria-label={t.player.speed}
              >
                {rate}×
              </Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent
            align="end"
            className="w-36"
            container={container}
          >
            <DropdownMenuLabel>{t.player.speed}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={String(rate)}
              onValueChange={(value) => onRate(Number(value))}
            >
              {SPEEDS.map((speed) => (
                <DropdownMenuRadioItem key={speed} value={String(speed)}>
                  {speed}×
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tip label={t.player.subtitles} keys="C" container={container}>
          <Button
            size="icon"
            variant="ghost"
            className={iconButton}
            onClick={onToggleCaptions}
            aria-label={t.player.subtitles}
            aria-pressed={captions}
          >
            {captions ? <CaptionsIcon /> : <CaptionsOffIcon />}
          </Button>
        </Tip>
        <Sheet onOpenChange={onMenuOpen}>
          <Tip label={t.player.settings} container={container}>
            <SheetTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className={iconButton}
                aria-label={t.player.settings}
              >
                <Settings2Icon />
              </Button>
            </SheetTrigger>
          </Tip>
          <SheetContent className="gap-0" container={container}>
            <SheetHeader>
              <SheetTitle>{t.player.settings}</SheetTitle>
              <SheetDescription>{t.player.settingsHint}</SheetDescription>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
                <CaptionSettings preview={false} />
              </div>
            </ScrollArea>
          </SheetContent>
        </Sheet>
        <Tip
          label={fullscreen ? t.player.exitFullscreen : t.player.fullscreen}
          keys="F"
          container={container}
        >
          <Button
            size="icon"
            variant="ghost"
            className={iconButton}
            onClick={onToggleFullscreen}
            aria-label={
              fullscreen ? t.player.exitFullscreen : t.player.fullscreen
            }
          >
            {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
          </Button>
        </Tip>
      </div>
    </div>
  )
}
