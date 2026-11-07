import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

// The tutor writes Markdown. Times like [3:05] become buttons that jump the
// video there (when there's a video to jump in).
//
// While an answer streams in, the text grows a few characters at a time.
// Re-parsing all of it on every change makes long answers stutter, so the
// text is cut into top-level blocks (at blank lines, outside code) and each
// block is memoised: only the block still being written is parsed again.

const TIME = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g

function toMs(time: string): number {
  return (
    time
      .split(":")
      .map(Number)
      .reduce((total, part) => total * 60 + part, 0) * 1000
  )
}

const FENCE = /^\s*(```|~~~)/
const plugins = [remarkGfm]

/** Top-level blocks of Markdown. A blank line followed by an indented line
 * (a list item's next paragraph) stays inside the block. */
function blocks(text: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let fenced = false
  let blank = false
  for (const line of text.split("\n")) {
    if (fenced) {
      current.push(line)
      if (FENCE.test(line)) fenced = false
      continue
    }
    if (line.trim() === "") {
      if (current.length) blank = true
      continue
    }
    if (blank) {
      if (/^\s/.test(line)) {
        current.push("")
      } else {
        out.push(current.join("\n"))
        current = []
      }
      blank = false
    }
    current.push(line)
    if (FENCE.test(line)) fenced = true
  }
  if (current.length) out.push(current.join("\n"))
  return out
}

export function Markdown({
  text,
  onSeek,
}: {
  text: string
  onSeek?: (ms: number) => void
}) {
  const parts = React.useMemo(() => blocks(text), [text])
  return (
    <div className="flex flex-col gap-2 leading-relaxed break-words [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
      {parts.map((part, index) => (
        <Block key={index} text={part} onSeek={onSeek} />
      ))}
    </div>
  )
}

const Block = React.memo(function Block({
  text,
  onSeek,
}: {
  text: string
  onSeek?: (ms: number) => void
}) {
  const components = React.useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        if (href?.startsWith("#t=") && onSeek) {
          const ms = Number(href.slice(3))
          return (
            <button
              type="button"
              onClick={() => onSeek(ms)}
              className="mx-0.5 inline-flex items-center rounded-md bg-primary/10 px-1.5 py-px font-mono text-[0.85em] text-primary tabular-nums hover:bg-primary/20"
            >
              {children}
            </button>
          )
        }
        const safe = href && /^https?:\/\//.test(href) ? href : undefined
        return (
          <a
            href={safe}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {children}
          </a>
        )
      },
      h1: ({ children }) => <p className="font-semibold">{children}</p>,
      h2: ({ children }) => <p className="font-semibold">{children}</p>,
      h3: ({ children }) => <p className="font-semibold">{children}</p>,
      code: ({ children }) => (
        <code className="rounded bg-muted px-1 font-mono text-[0.9em]">
          {children}
        </code>
      ),
      img: () => null,
    }),
    [onSeek]
  )
  const source = onSeek
    ? text.replace(TIME, (_, time: string) => `[${time}](#t=${toMs(time)})`)
    : text
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {source}
    </ReactMarkdown>
  )
})
