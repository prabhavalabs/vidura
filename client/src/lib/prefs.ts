import * as React from "react"

// Subtitle preferences, saved in this browser.

export type CaptionLanguage = "si" | "both" | "en"
export type CaptionPlacement = "below" | "overlay"
export type CaptionOutline = "none" | "shadow" | "stroke"

/** Subtitle typefaces: all have Sinhala letters, all are served by Vidura. */
export const captionFonts = {
  "noto-sans": {
    label: "Noto Sans",
    family: `"Noto Sans Sinhala Variable", "Geist Variable", sans-serif`,
  },
  "noto-serif": {
    label: "Noto Serif",
    family: `"Noto Serif Sinhala Variable", Georgia, serif`,
  },
  yaldevi: {
    label: "Yaldevi",
    family: `"Yaldevi Variable", "Noto Sans Sinhala Variable", sans-serif`,
  },
  abhaya: {
    label: "Abhaya Libre",
    family: `"Abhaya Libre", "Noto Serif Sinhala Variable", serif`,
  },
  gemunu: {
    label: "Gemunu Libre",
    family: `"Gemunu Libre Variable", "Noto Sans Sinhala Variable", sans-serif`,
  },
} as const

export type CaptionFont = keyof typeof captionFonts

export type Prefs = {
  captions: boolean
  language: CaptionLanguage
  placement: CaptionPlacement
  /** Distance of overlay subtitles from the bottom of the video, 0–85 %. */
  position: number
  font: CaptionFont
  /** Caption text size in pixels (on a wide screen). */
  size: number
  color: string
  backgroundColor: string
  /** Caption background opacity, 0–100. */
  background: number
  outline: CaptionOutline
}

export const defaultPrefs: Prefs = {
  captions: true,
  language: "si",
  placement: "overlay",
  position: 10,
  font: "noto-sans",
  size: 26,
  color: "#ffffff",
  backgroundColor: "#000000",
  background: 60,
  outline: "shadow",
}

const KEY = "vidura.prefs"
const listeners = new Set<() => void>()
let cache: Prefs | null = null

function read(): Prefs {
  if (cache) return cache
  const merged = { ...defaultPrefs, ...saved() }
  if (!(merged.font in captionFonts)) merged.font = defaultPrefs.font
  cache = merged
  return cache
}

function saved(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>
  } catch {
    return {}
  }
}

export function setPrefs(change: Partial<Prefs>) {
  cache = { ...read(), ...change }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    // Private browsing: keep the change for this visit only.
  }
  listeners.forEach((listener) => listener())
}

export function resetPrefs() {
  setPrefs(defaultPrefs)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePrefs(): Prefs {
  return React.useSyncExternalStore(subscribe, read, () => defaultPrefs)
}

/** "#112233" + 60 → "rgb(17 34 51 / 0.6)". */
export function withAlpha(hex: string, percent: number): string {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? "000000"
  const n = parseInt(value, 16)
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${percent / 100})`
}
