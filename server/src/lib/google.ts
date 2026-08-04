// Official Google APIs for YouTube data — no scraping, no cookies, no proxies.
//
//  * Metadata:   YouTube Data API v3 `videos.list` (API key).
//  * Transcript: Gemini API video understanding — Google ingests a public
//    YouTube URL on their own infrastructure and returns a timestamped
//    transcription. (The Data API's captions.download is owner-only, so it
//    cannot fetch third-party captions; Gemini is the official path.)
//
// One Cloud Console API key can serve both when "YouTube Data API v3" and
// "Generative Language API" are enabled on the project.

import { env } from "../env.ts";
import type { NormalizedTranscriptSegment, VideoMetadata } from "./youtube.ts";

const GEMINI_TIMEOUT_MS = 240_000; // video ingestion takes a while
const DATA_API_TIMEOUT_MS = 15_000;

// ---- Metadata via YouTube Data API v3 ----

export async function fetchMetadataViaDataApi(
  videoId: string,
): Promise<VideoMetadata | null> {
  if (!env.youtubeApiKey) return null;

  try {
    const url = "https://www.googleapis.com/youtube/v3/videos" +
      `?part=snippet,contentDetails&id=${videoId}&key=${env.youtubeApiKey}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DATA_API_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = await res.json() as any;
    const item = data?.items?.[0];
    if (!item) return null;

    const snippet = item.snippet ?? {};
    const thumbs = snippet.thumbnails ?? {};
    const bestThumb = thumbs.maxres?.url ?? thumbs.standard?.url ??
      thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null;

    return {
      title: typeof snippet.title === "string" ? snippet.title : null,
      channelTitle: typeof snippet.channelTitle === "string"
        ? snippet.channelTitle
        : null,
      durationMs: parseIsoDuration(item.contentDetails?.duration),
      thumbnailUrl: bestThumb ??
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  } catch {
    return null;
  }
}

// ---- Metadata via keyless oembed (fallback when no Data API key) ----
// Returns title, channel, thumbnail — but no duration. Works from any IP.

export async function fetchMetadataViaOembed(
  videoId: string,
): Promise<VideoMetadata | null> {
  try {
    const url = "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DATA_API_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = await res.json() as any;
    if (typeof data?.title !== "string") return null;

    return {
      title: data.title,
      channelTitle: typeof data.author_name === "string"
        ? data.author_name
        : null,
      durationMs: null,
      thumbnailUrl: typeof data.thumbnail_url === "string"
        ? data.thumbnail_url
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  } catch {
    return null;
  }
}

// ISO-8601 duration (PT#H#M#S) → milliseconds.
function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  const [, h, min, s] = m;
  const totalSeconds = Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 +
    Number(s ?? 0);
  return totalSeconds > 0 ? Math.round(totalSeconds * 1000) : null;
}

// ---- Transcript via Gemini video understanding ----

const TRANSCRIBE_PROMPT = [
  "Transcribe the spoken audio of this video into subtitle segments.",
  'Return ONLY a JSON array. Each element: {"start": <number, seconds from the start of the video>, "text": "<the spoken words>"}.',
  "Rules:",
  "- Segments must be in chronological order and cover the entire video.",
  "- Each segment is ONE short spoken phrase (at most ~12 words).",
  "- Transcribe in the original spoken language; do not translate.",
  "- Spoken words only: no visual descriptions, sound effects, music labels, or speaker names.",
  "- start values are numbers (seconds, may include decimals), strictly non-decreasing.",
].join("\n");

export async function fetchTranscriptViaGemini(
  videoId: string,
): Promise<NormalizedTranscriptSegment[] | null> {
  if (!env.geminiApiKey) return null;

  let lastError: unknown = null;

  // Two attempts; the second drops mediaResolution in case the model/API
  // rejects that option.
  for (const useLowResolution of [true, false]) {
    try {
      const segments = await geminiTranscribeOnce(videoId, useLowResolution);
      if (segments.length > 0) return segments;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Gemini transcription failed");
  }
  return null;
}

async function geminiTranscribeOnce(
  videoId: string,
  lowResolution: boolean,
): Promise<NormalizedTranscriptSegment[]> {
  const model = env.geminiModel;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    responseMimeType: "application/json",
    // Ask for the model's full output budget. The default is a few thousand
    // tokens, which ends the JSON transcript partway through a long video —
    // the same truncation the segment caps used to cause, one layer down.
    maxOutputTokens: 65_536,
  };
  if (lowResolution) {
    // Audio is what matters for transcription; low frame resolution cuts
    // token usage roughly 3x.
    generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.geminiApiKey,
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            fileData: {
              fileUri: `https://www.youtube.com/watch?v=${videoId}`,
            },
          },
          { text: TRANSCRIBE_PROMPT },
        ],
      }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Gemini transcription failed with ${res.status}: ${detail.slice(0, 300)}`,
    );
  }

  const data = await res.json() as any;
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .join("") ?? "";

  return parseGeminiSegments(text);
}

function parseGeminiSegments(raw: string): NormalizedTranscriptSegment[] {
  const jsonText = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.segments)
    ? (parsed as any).segments
    : [];

  const out: NormalizedTranscriptSegment[] = [];
  let lastStart = -1;

  for (const item of items as Array<Record<string, unknown>>) {
    const start = Number(item?.start);
    const text = String(item?.text ?? "").replace(/\s+/g, " ").trim();
    if (!Number.isFinite(start) || start < 0 || !text) continue;

    const startMs = Math.round(Math.max(start, lastStart >= 0 ? lastStart : 0) * 1000);
    lastStart = startMs / 1000;
    out.push({ index: out.length, startMs, endMs: startMs + 1, text });
  }

  // Derive each segment's end from the next segment's start (captions are
  // contiguous), capping long gaps and giving the last line a default length.
  for (let i = 0; i < out.length; i += 1) {
    const current = out[i]!;
    const next = out[i + 1];
    const cap = current.startMs + 8_000;
    current.endMs = next
      ? Math.max(current.startMs + 1, Math.min(next.startMs, cap))
      : current.startMs + 5_000;
  }

  // No cap here: length is bounded once, after consolidation (MAX_SEGMENTS in
  // youtube.ts). A 500-segment cap at this stage ended the transcript ~25
  // minutes into any video that fell back to this path.
  return out;
}
