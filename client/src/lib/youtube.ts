// YouTube's IFrame Player API, loaded once on demand. Only the parts the
// watch page uses are typed.

export type YTPlayer = {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  mute(): void
  unMute(): void
  isMuted(): boolean
  getVolume(): number
  setVolume(volume: number): void
  setPlaybackRate(rate: number): void
  /** Removes a player module; "captions" turns YouTube's own subtitles off. */
  unloadModule(module: string): void
  destroy(): void
}

type YTNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      host?: string
      videoId: string
      width?: string
      height?: string
      playerVars?: Record<string, string | number>
      events?: {
        onReady?: () => void
        onStateChange?: (event: { data: number }) => void
        onError?: (event: { data: number }) => void
      }
    }
  ) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

/** Player states from the API. */
export const PlayerState = {
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
  cued: 5,
} as const

let loading: Promise<YTNamespace> | null = null

export function loadYouTube(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT) resolve(window.YT)
    }
    const script = document.createElement("script")
    script.src = "https://www.youtube.com/iframe_api"
    script.async = true
    script.onerror = () => {
      loading = null
      reject(new Error("Couldn’t load the YouTube player."))
    }
    document.head.appendChild(script)
  })
  return loading
}

/** Errors YouTube reports when a video can't be played inside another site. */
export const embedBlocked = new Set([2, 5, 100, 101, 150, 153])
