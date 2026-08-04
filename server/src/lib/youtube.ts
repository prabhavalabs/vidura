// YouTube URL parsing, metadata, and transcript extraction.
//
// Two transcript sources, chosen automatically:
//   1. yt-dlp through a residential proxy (YOUTUBE_PROXY_URL) — fetches
//      YouTube's OWN caption track, so timing is frame-accurate. Only tried
//      when a proxy is set, because the VPS's datacenter IP is blocked.
//   2. Gemini (Google fetches the public URL on its own IP) — audio ASR with
//      ~±3s timestamps. Used when there's no proxy, or as a fallback for
//      videos that have no caption track.
// Desktop users can also push a transcript from the browser userscript (see
// routes/ingest.ts), which bypasses this module entirely.

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../env.ts";
import {
  fetchMetadataViaDataApi,
  fetchMetadataViaOembed,
  fetchTranscriptViaGemini,
} from "./google.ts";

export type ParsedYouTubeUrl = {
  videoId: string;
  canonicalUrl: string;
};

export type NormalizedTranscriptSegment = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type VideoMetadata = {
  title: string | null;
  channelTitle: string | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
};

export type YouTubeVideoData = {
  metadata: VideoMetadata;
  segments: NormalizedTranscriptSegment[];
  // Which pipeline produced the timings. "ytdlp" captions are frame-accurate;
  // "gemini" is audio ASR and can drift by a few seconds — recorded so the
  // source is diagnosable after the fact.
  source: "ytdlp" | "gemini";
};

const youtubeIdPattern = /^[a-zA-Z0-9_-]{11}$/;
const YTDLP_TIMEOUT_MS = 90_000;
// Ceiling on FINAL subtitle lines, applied once — in consolidateSegments, to
// every transcript source. Counting RAW cues instead was a duration limit in
// disguise: captions arrive at roughly one cue per two seconds of speech, so
// the old 2000-cue cap cut every video off at ~72 minutes regardless of its
// length (a 108-minute talk kept 67%, a 3-hour one ~40%) — and did it
// silently. Consolidation merges ~3-4 cues per line, so this bounds an
// ~8-hour video, and anything it does trim is logged rather than swallowed.
const MAX_SEGMENTS = 6000;

// Sentence-consolidation tuning. Raw caption cues are 2–4s phrase fragments
// that flip too fast to read; merging them into sentence-level lines makes
// subtitles readable AND gives the translator complete sentences to work with.
const MERGE_MIN_CHARS = 40; // don't close on punctuation before this length
const MERGE_MAX_CHARS = 120; // hard break: overlay fits ~3 lines on mobile
const MERGE_MAX_DURATION_MS = 9_000; // hard break: one line ≤ ~9s on screen
const MERGE_MAX_BRIDGE_GAP_MS = 2_500; // never merge across real silence

// Readability floor (professional guides: Netflix min ~0.83s, ~17 chars/sec
// for non-English; we're MORE generous since viewers read a translation).
// A line may linger into following silence to hit these — never past the
// next line's start, so sync is untouched.
const MIN_DISPLAY_MS = 1_500; // anything shorter flashes by unread
const READING_CPS = 14; // chars/sec a learner comfortably reads
const MAX_LINGER_MS = 1_200; // how far past speech a line may stay up

const sentenceEndPattern = /[.!?…][)"'”’]*$/;
// Sound-effect cues like [Music], [Applause], (laughs) — noise, not speech.
const soundTagPattern = /^[\[(][^\])]{1,40}[\])]$/;

export function parseYouTubeUrl(value: string): ParsedYouTubeUrl | null {
  const input = value.trim();
  if (!input) return null;

  const normalizedInput = input.startsWith("http") ? input : `https://${input}`;

  try {
    const url = new URL(normalizedInput);
    const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
    let videoId: string | null = null;

    if (host === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
    }

    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      videoId = url.searchParams.get("v") ??
        parseVideoIdFromPath(url.pathname, ["shorts", "embed", "live"]);
    }

    if (!videoId || !youtubeIdPattern.test(videoId)) {
      return null;
    }

    return {
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  } catch {
    return null;
  }
}

function parseVideoIdFromPath(pathname: string, routeNames: string[]) {
  const [route, id] = pathname.split("/").filter(Boolean);
  if (!route || !routeNames.includes(route)) return null;
  return id ?? null;
}

export function fallbackMetadata(videoId: string): VideoMetadata {
  return {
    title: null,
    channelTitle: null,
    durationMs: null,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

// Transcript + metadata. Prefers yt-dlp through the proxy (frame-accurate
// YouTube captions); falls back to Gemini (audio ASR) with no proxy or when
// the video has no caption track.
export async function fetchYouTubeVideoData(
  videoId: string,
): Promise<YouTubeVideoData> {
  if (env.youtubeProxyUrl) {
    try {
      return await fetchViaYtDlp(videoId);
    } catch (error) {
      // No caption track, or a yt-dlp/proxy hiccup — fall through to Gemini.
      // Logged because this fallback silently downgrades timing accuracy, and
      // a transient proxy failure looks exactly like a video that genuinely
      // has no captions unless the reason is written down.
      console.error(
        `yt-dlp transcript failed for ${videoId}, falling back to Gemini:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const segments = await fetchTranscriptViaGemini(videoId);
  if (!segments || segments.length === 0) {
    throw new Error(
      "Couldn't get a transcript for this video. Set YOUTUBE_PROXY_URL or " +
        "GEMINI_API_KEY, or add it from the browser transcript helper.",
    );
  }

  const metadata = await fetchYouTubeMetadata(videoId);
  return { metadata, segments, source: "gemini" };
}

// yt-dlp through the proxy: YouTube's own caption track (json3) + real
// metadata. Throws when the video has no captions so the caller can fall back.
async function fetchViaYtDlp(videoId: string): Promise<YouTubeVideoData> {
  const dir = await mkdtemp(join(tmpdir(), "vidura-yt-"));

  try {
    // Only the ORIGINAL English track: manual "en" or auto "en-orig". A glob
    // like "en.*" also matches YouTube's ~30 auto-translated variants
    // (en-ar, en-fr, …); downloading them all trips YouTube's rate limiter
    // (HTTP 429), makes yt-dlp exit non-zero, and used to discard the accurate
    // caption we already had — silently falling back to Gemini's drifty ASR.
    const result = await runYtDlp([
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "en-orig,en,-live_chat",
      "--sub-format",
      "json3",
      "--write-info-json",
      "--no-warnings",
      "--no-playlist",
      "--retries",
      "3",
      "-o",
      join(dir, "%(id)s"),
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);

    const files = await readdir(dir);
    const metadata = await readInfoJson(dir, files, videoId);

    // Prefer a manual English track; fall back to en-orig/en-*, then any json3.
    const subFile = files.find((f) => /\.en\.json3$/.test(f)) ??
      files.find((f) => /\.en[.-][^.]*\.json3$/.test(f)) ??
      files.find((f) => f.endsWith(".json3"));

    // A non-zero exit is only fatal if we got NO usable caption. yt-dlp can
    // exit 1 on a transient per-track hiccup after already writing the track
    // we want, so file presence — not exit code — decides success here.
    if (!subFile) {
      throw new Error(
        result.exitCode === 0
          ? `No caption track for ${videoId}`
          : `yt-dlp failed (${result.exitCode}): ${result.errorDetail}`,
      );
    }

    const segments = parseJson3(await readFile(join(dir, subFile), "utf8"));
    if (segments.length === 0) {
      throw new Error(`Empty caption track for ${videoId}`);
    }

    return { metadata, segments, source: "ytdlp" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Metadata only (used when the client supplied the transcript). Data API →
// keyless oembed → thumbnail-only fallback.
export async function fetchYouTubeMetadata(
  videoId: string,
): Promise<VideoMetadata> {
  return (await fetchMetadataViaDataApi(videoId)) ??
    (await fetchMetadataViaOembed(videoId)) ??
    fallbackMetadata(videoId);
}

async function readInfoJson(
  dir: string,
  files: string[],
  videoId: string,
): Promise<VideoMetadata> {
  const infoFile = files.find((f) => f.endsWith(".info.json"));
  if (!infoFile) return fallbackMetadata(videoId);
  try {
    const info = JSON.parse(await readFile(join(dir, infoFile), "utf8"));
    return infoToMetadata(info, videoId);
  } catch {
    return fallbackMetadata(videoId);
  }
}

function infoToMetadata(info: any, videoId: string): VideoMetadata {
  const fallback = fallbackMetadata(videoId);
  return {
    title: typeof info?.title === "string" ? info.title : null,
    channelTitle: typeof info?.uploader === "string"
      ? info.uploader
      : typeof info?.channel === "string"
      ? info.channel
      : null,
    durationMs: typeof info?.duration === "number"
      ? Math.round(info.duration * 1000)
      : null,
    thumbnailUrl: typeof info?.thumbnail === "string"
      ? info.thumbnail
      : fallback.thumbnailUrl,
  };
}

// Merges consecutive caption cues into sentence-level subtitle lines. Raw cues
// are short phrase fragments (a manual track averages ~3s, ASR ~2s) that flip
// faster than anyone can read; a line that carries a complete thought is both
// easier to follow and translates better, since the model sees whole sentences.
// A segment closes when:
//   - the accumulated text ends a sentence and has reached a readable length,
//   - a hard cap is hit (length or on-screen duration) even mid-sentence, or
//   - the next cue starts after a real pause — silence is never bridged, so
//     quiet stretches in the video stay subtitle-free.
// Timing stays exact: a merged line spans first cue start → last cue end.
// This is also the pipeline's ONE length cap (MAX_SEGMENTS), applied here
// because merged lines are what actually cost translation tokens and DB rows.
export function consolidateSegments(
  segments: NormalizedTranscriptSegment[],
): NormalizedTranscriptSegment[] {
  // Sound tags ([Music], (laughs)) aren't speech — translating and flashing
  // them as subtitles is noise. Drop them before merging.
  const speech = segments.filter((s) => !soundTagPattern.test(s.text.trim()));

  const out: NormalizedTranscriptSegment[] = [];
  let current: NormalizedTranscriptSegment | null = null;

  for (let i = 0; i < speech.length; i += 1) {
    const cue = speech[i];
    if (!cue) continue;

    // Close BEFORE appending a cue that would blow past a hard cap, so lines
    // stay within the caps instead of overshooting by one cue's worth.
    if (
      current &&
      (current.text.length + 1 + cue.text.length > MERGE_MAX_CHARS ||
        cue.endMs - current.startMs > MERGE_MAX_DURATION_MS)
    ) {
      out.push(current);
      current = null;
    }

    if (!current) {
      current = { ...cue };
    } else {
      current.text = `${current.text} ${cue.text}`;
      current.endMs = cue.endMs;
    }

    const next = speech[i + 1];
    const gapToNext = next ? next.startMs - current.endMs : Infinity;
    const sentenceDone = sentenceEndPattern.test(current.text);
    const closeSegment = gapToNext > MERGE_MAX_BRIDGE_GAP_MS ||
      (sentenceDone && current.text.length >= MERGE_MIN_CHARS);

    if (closeSegment) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);

  // Readability pass: every line must stay on screen long enough to be read.
  // Extend a line's end into the following silence — never past the next
  // line's start — until it meets the display floor: at least MIN_DISPLAY_MS,
  // and at least the time needed to read it at READING_CPS (capped by
  // MAX_LINGER_MS past the spoken audio so silence stays mostly silent).
  for (let i = 0; i < out.length; i += 1) {
    const seg = out[i];
    if (!seg) continue;
    const nextStart = out[i + 1]?.startMs ?? Number.MAX_SAFE_INTEGER;
    const readingMs = Math.round((seg.text.length / READING_CPS) * 1000);
    const desiredEnd = Math.max(
      seg.startMs + MIN_DISPLAY_MS,
      Math.min(seg.startMs + readingMs, seg.endMs + MAX_LINGER_MS),
    );
    seg.endMs = Math.min(nextStart, Math.max(seg.endMs, desiredEnd));
  }

  // The single length cap. Logged when it bites: a transcript that stops
  // before the video does is the one failure users actually notice, so it
  // must never happen quietly again.
  if (out.length > MAX_SEGMENTS) {
    console.warn(
      `transcript truncated to ${MAX_SEGMENTS} subtitle lines (from ` +
        `${out.length}) — video exceeds the supported length`,
    );
    out.length = MAX_SEGMENTS;
  }

  return out.map((segment, index) => ({ ...segment, index }));
}

// Parses YouTube's json3 caption format into normalized segments.
function parseJson3(raw: string): NormalizedTranscriptSegment[] {
  const data = JSON.parse(raw);
  const events = Array.isArray(data?.events) ? data.events : [];
  const out: NormalizedTranscriptSegment[] = [];
  let lastText = "";

  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue;

    const text = event.segs
      .map((seg: any) => (typeof seg?.utf8 === "string" ? seg.utf8 : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    // Skip empties and consecutive duplicates (auto-caption rolling lines).
    if (!text || text === lastText) continue;
    lastText = text;

    const startMs = Math.max(0, Math.floor(Number(event.tStartMs) || 0));
    const durMs = Math.max(1, Math.floor(Number(event.dDurationMs) || 4500));

    out.push({ index: out.length, startMs, endMs: startMs + durMs, text });
  }

  // Auto-generated (ASR) captions overshoot: each rolling window's dDurationMs
  // runs well past the next cue's start, so at any instant two cues overlap and
  // the player shows the earlier one — the subtitle visibly lags the audio.
  // Clamp every cue to end where the next begins for continuous, correctly
  // synced captions. Manual tracks don't overlap, so this leaves them untouched
  // (real gaps of silence between cues are preserved, never stretched).
  for (let i = 0; i < out.length - 1; i += 1) {
    const cur = out[i];
    const next = out[i + 1];
    if (cur && next && cur.endMs > next.startMs) {
      cur.endMs = Math.max(cur.startMs + 1, next.startMs);
    }
  }

  // Re-index after any drops. Length is bounded once, after consolidation —
  // never here, where a count of raw cues is really a limit on how many
  // minutes of the video survive.
  return out.map((seg, index) => ({ ...seg, index }));
}

type YtDlpResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorDetail: string;
};

// Runs yt-dlp and returns its exit code rather than throwing on failure — the
// caller decides whether a non-zero exit matters, since yt-dlp can fail on one
// track after successfully writing the one we actually need.
async function runYtDlp(args: string[]): Promise<YtDlpResult> {
  const fullArgs = [...args];
  // The residential proxy gives yt-dlp a clean IP YouTube trusts.
  if (env.youtubeProxyUrl) {
    fullArgs.unshift("--proxy", env.youtubeProxyUrl);
  }

  const proc = Bun.spawn(["yt-dlp", ...fullArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, YTDLP_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const errorDetail = stderr
      .split("\n")
      .filter(Boolean)
      .slice(-2)
      .join(" ")
      .slice(0, 300);

    return { stdout, stderr, exitCode, errorDetail };
  } finally {
    clearTimeout(timer);
  }
}
