import { cn } from "cn"

import { captionFonts, withAlpha, type Prefs } from "@/lib/prefs"

const outlines: Record<Prefs["outline"], string | undefined> = {
  none: undefined,
  shadow: "0 1px 2px rgb(0 0 0 / 0.9), 0 0 6px rgb(0 0 0 / 0.6)",
  // An outline drawn with eight shadows works with every script, Sinhala
  // vowel signs included (text-stroke draws inside the letters).
  stroke: [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ]
    .map(([x, y]) => `${x * 1.5}px ${y * 1.5}px 0 rgb(0 0 0 / 0.95)`)
    .join(", "),
}

/** One subtitle line in the chosen language(s) and style. */
export function Caption({
  sinhala,
  english,
  prefs,
  className,
}: {
  sinhala: string | null
  english: string
  prefs: Prefs
  className?: string
}) {
  const showSinhala = prefs.language !== "en" && Boolean(sinhala)
  const showEnglish = prefs.language !== "si" || !sinhala
  return (
    <div
      className={cn(
        "max-w-[min(56rem,100%)] rounded-md px-3 py-1.5 text-center leading-snug",
        className
      )}
      style={{
        color: prefs.color,
        backgroundColor: withAlpha(prefs.backgroundColor, prefs.background),
        fontFamily: captionFonts[prefs.font].family,
        fontSize: `clamp(14px, 4.4vw, ${prefs.size}px)`,
        textShadow: outlines[prefs.outline],
      }}
    >
      {showSinhala && <p lang="si">{sinhala}</p>}
      {showEnglish && (
        <p
          lang="en"
          className={cn(showSinhala && "mt-0.5 text-[0.78em] opacity-85")}
        >
          {english}
        </p>
      )}
    </div>
  )
}
