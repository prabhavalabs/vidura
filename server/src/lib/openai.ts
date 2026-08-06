// Sinhala translation via OpenAI structured outputs, streamed for live progress.
//
// The whole English transcript (with timestamps, for context and pacing) goes in
// one request; a strict json_schema returns one clean Sinhala line per index.
// The response is streamed so we can count completed lines and report granular
// progress. LLMs occasionally drop indices on long lists, so any missing lines
// are re-requested (with the full transcript still supplied as context) until
// every index is covered or a small round cap is hit.

import { env } from "../env.ts";
import type {
  NormalizedTranscriptSegment,
  VideoMetadata,
} from "./youtube.ts";
import { chunkSegments, type TranslationResult } from "./translation.ts";
import {
  resolveTranslationProviderConfig,
  type TranslationProviderConfig,
} from "./translation-provider.ts";

// A stream that is actively producing tokens must never be killed, no matter
// how long the full response takes — a fixed total-duration timeout used to
// abort long translations mid-flight whenever the provider had a slow spell,
// failing the whole job. Abort only when the stream goes QUIET (idle), with a
// generous overall cap purely as a hung-connection backstop.
const STREAM_IDLE_TIMEOUT_MS = 90_000;
const STREAM_MAX_MS = 20 * 60_000;
const MAX_ROUNDS = 4;
// How many lines one request may be asked to translate. The binding limit is
// the RESPONSE budget, not the context window: each translated line costs
// ~110 tokens of JSON, so asking for a whole long video at once runs past the
// model's max output and the stream stops mid-transcript — leaving the tail of
// a 2h+ video untranslated no matter how complete the transcript is. The full
// transcript still goes into every call as context, so each window is
// translated with whole-video understanding; only the ask is windowed.
const MAX_LINES_PER_CALL = 500;

// Resolves the translation endpoint from TRANSLATION_PROVIDER. Both providers
// speak the OpenAI chat-completions API, so the streaming logic is shared.
function resolveProvider(): TranslationProviderConfig {
  return resolveTranslationProviderConfig({
    provider: env.translationProvider,
    openaiApiKey: env.openaiApiKey,
    openaiModel: env.openaiModel,
    openRouterApiKey: env.openRouterApiKey,
    openRouterModel: env.openRouterModel,
  });
}

export function singleShotTranslationEnabled(): boolean {
  resolveProvider();
  return true;
}

export function translationModelName(): string {
  return resolveProvider().model;
}

function timestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const body = `${mm}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${body}` : body;
}

// The core translation contract. This lives at the CODE level and is never
// user-editable: per-user preferences are appended AFTER it and may only add
// to it — they can never replace or override these rules, which encode the
// application's translation quality tuning.
function corePrompt(targetLanguage: string): string {
  return [
    `You are an expert subtitle localizer translating educational YouTube videos into natural, fluent, spoken ${targetLanguage}.`,
    "CONTEXT: you are given the ENTIRE transcript of one video. Read and understand ALL of it before translating anything — resolve ambiguous words, pronouns, and references using the whole video's context and its title. Never translate a line in isolation.",
    `MEANING OVER WORDS: translate the meaning, not the words. Write idiomatic ${targetLanguage} that a native speaker would actually say while explaining the same idea. Avoid calques, word-for-word renderings, and awkward word order.`,
    "CONSISTENCY: keep terminology consistent across the entire video — once a term is rendered one way, use the same rendering everywhere.",
    `MIXED LANGUAGE: when a technical term, brand name, or proper noun has no natural ${targetLanguage} equivalent — or when native speakers commonly say the English word anyway — keep the English word inside the ${targetLanguage} sentence rather than forcing an awkward literal translation. Everyday, non-technical language must still be written in natural ${targetLanguage}.`,
    "Each line carries one or two complete sentences; translate each line as natural spoken sentences that stand on their own while staying consistent with the surrounding lines. If a sentence spills across lines, let the translation flow naturally across those indices.",
    "SUBTITLE BREVITY: viewers read each line in a few seconds. Keep every line concise; when a literal rendering would be much longer than the original, prefer a shorter natural phrasing with the same meaning.",
  ].join("\n");
}

const FORMAT_RULES = [
  "You are given the ENTIRE English transcript of one video as an ordered list of lines, each with an index and a timestamp, plus `translateIndices` — the indices to translate right now. Read the whole transcript first for context, then translate the requested lines.",
  "- Return EXACTLY one object for every index in `translateIndices` — never skip, merge, drop, split, or reorder indices. The number of objects MUST equal the number of requested indices.",
  "- ALIGNMENT IS CRITICAL: each object's \"text\" must be the translation of the line AT THAT EXACT INDEX — not the line before or after it. To prove alignment, each object must also carry \"src\": the first 4-6 words of the English line at that index, copied VERBATIM from the transcript. Translations whose src does not match their index are rejected.",
  '- Output format: a single JSON object shaped EXACTLY like {"translations":[{"index":0,"src":"This is a 3.","text":"..."},{"index":1,"src":"And I want you","text":"..."}]} — an array under the "translations" key, one object per requested index. Do not use any other shape (no index-keyed maps).',
].join("\n");

// Core rules + format contract always apply; the user's saved guidance is
// appended as ADDITIVE preferences that explicitly lose any conflict.
function systemPrompt(targetLanguage: string, userGuidance?: string): string {
  const base = `${corePrompt(targetLanguage)}\n\n${FORMAT_RULES}`;
  const extra = userGuidance?.trim();
  if (!extra) return base;
  return `${base}\n\nADDITIONAL USER PREFERENCES — apply these only where they do not conflict with the rules above; when they conflict, the rules above always win:\n${extra}`;
}

// A translated line plus the model's verbatim echo of the source words it
// translated — used to verify the translation belongs to its index.
type AlignedTranslation = TranslationResult & { src?: string };

// Accepts the expected {translations:[{index,src,text}]} shape, a bare array,
// or an index-keyed map {"0":"…"} (which some models emit in json_object mode).
function extractTranslations(parsed: any): AlignedTranslation[] {
  const out: AlignedTranslation[] = [];
  const push = (index: unknown, text: unknown, src?: unknown) => {
    const i = Number(index);
    const t = String(text ?? "").trim();
    if (!Number.isInteger(i) || i < 0 || !t) return;
    const s = typeof src === "string" && src.trim() ? src.trim() : undefined;
    out.push({ index: i, text: t, src: s });
  };

  const arr = Array.isArray(parsed?.translations)
    ? parsed.translations
    : Array.isArray(parsed)
    ? parsed
    : null;

  if (arr) {
    for (const item of arr) push(item?.index, item?.text, item?.src);
  } else if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") push(key, value);
    }
  }
  return out;
}

// True when the model's echoed source snippet matches the actual line at that
// index — i.e. the translation really belongs there. LLMs drift alignment on
// long index lists (line N gets line N±1's translation); comparing the echo
// against the transcript makes storing a misaligned line impossible.
// Lenient on punctuation/case/quotes: only letters and digits are compared.
function srcMatchesSegment(src: string | undefined, segmentText: string): boolean {
  if (!src) return false;
  const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const a = norm(src).slice(0, 24);
  const b = norm(segmentText).slice(0, 48);
  if (a.length < 4) return false; // too short to prove anything
  return b.startsWith(a.slice(0, Math.min(a.length, 16)));
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          // Verbatim first words of the English line at this index — proves
          // the translation is aligned to the right line.
          src: { type: "string" },
          text: { type: "string" },
        },
        required: ["index", "src", "text"],
      },
    },
  },
  required: ["translations"],
};

export async function translateTranscriptOpenAI(input: {
  segments: NormalizedTranscriptSegment[];
  metadata: Pick<VideoMetadata, "title" | "channelTitle">;
  targetLanguage: string;
  // Optional per-user preferences, appended AFTER the immutable core prompt.
  userGuidance?: string;
  // Lines already translated (e.g. stored by an earlier attempt of the same
  // job). Seeding them means only the missing indices are requested, so a
  // retried job RESUMES instead of re-translating the whole video.
  seed?: Map<number, string>;
  // Called as each translation line finishes streaming, for live progress.
  onProgress?: (completed: number, total: number) => void;
  // Called after each round with that round's NEW lines, so the caller can
  // persist partial progress — a crash or restart then loses at most a round.
  onRoundResults?: (results: TranslationResult[]) => Promise<void>;
}): Promise<TranslationResult[]> {
  resolveProvider();
  const total = input.segments.length;
  if (total === 0) return [];

  const byIndex = new Map<number, string>(input.seed ?? []);
  const textByIndex = new Map(input.segments.map((s) => [s.index, s.text]));

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const missing = input.segments.filter((s) => !byIndex.has(s.index));
    if (missing.length === 0) break;

    const roundStart = byIndex.size;

    // Each round covers ALL remaining lines, in windows small enough to fit
    // one response. Rounds exist to mop up indices the model dropped or
    // misaligned — never to page through a long video, which is what left
    // long transcripts partly untranslated.
    for (const window of chunkSegments(missing, MAX_LINES_PER_CALL)) {
      const base = byIndex.size;
      let results: AlignedTranslation[];
      try {
        results = await streamTranslationCall({
          segments: input.segments,
          targetIndices: window.map((s) => s.index),
          metadata: input.metadata,
          targetLanguage: input.targetLanguage,
          userGuidance: input.userGuidance,
          onLine: (count) =>
            input.onProgress?.(Math.min(base + count, total), total),
        });
      } catch (error) {
        // One garbage or dropped response must not fail the whole attempt —
        // every earlier window's lines are already persisted, and the next
        // round re-requests whatever is still missing. Give up only when all
        // rounds pass without producing a single line (checked after loop).
        console.error(
          `translate round ${round + 1}/${MAX_ROUNDS} window ` +
            `${window[0]?.index}-${window[window.length - 1]?.index} failed:`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }

      const fresh: TranslationResult[] = [];
      let rejected = 0;
      for (const r of results) {
        const sourceText = textByIndex.get(r.index);
        if (sourceText === undefined) continue; // index outside this transcript
        // Alignment gate: only store a line whose echoed source words match
        // the line at that index. Drifted lines are dropped and re-requested
        // next round — a misaligned translation can never reach the database.
        if (!srcMatchesSegment(r.src, sourceText)) {
          rejected += 1;
          continue;
        }
        if (!byIndex.has(r.index)) {
          byIndex.set(r.index, r.text);
          fresh.push({ index: r.index, text: r.text });
        }
      }
      if (rejected > 0) {
        console.error(
          `translate round ${round + 1}: rejected ${rejected}/${results.length} misaligned lines`,
        );
      }
      input.onProgress?.(byIndex.size, total);
      // Persist per WINDOW, not per round, so a crash midway through a long
      // video keeps everything already translated.
      if (fresh.length > 0) await input.onRoundResults?.(fresh);
    }

    // A full round that added nothing means retrying won't help — stop rather
    // than loop forever.
    if (byIndex.size === roundStart) break;
  }

  const out = input.segments
    .filter((s) => byIndex.has(s.index))
    .map((s) => ({ index: s.index, text: byIndex.get(s.index)! }));

  if (out.length === 0) {
    throw new Error("OpenAI translation returned no usable lines");
  }
  return out;
}

async function streamTranslationCall(input: {
  segments: NormalizedTranscriptSegment[];
  targetIndices: number[];
  metadata: Pick<VideoMetadata, "title" | "channelTitle">;
  targetLanguage: string;
  userGuidance?: string;
  onLine: (count: number) => void;
}): Promise<AlignedTranslation[]> {
  const user = {
    videoTitle: input.metadata.title,
    channelTitle: input.metadata.channelTitle,
    targetLanguage: input.targetLanguage,
    instruction:
      "Translate every transcript line whose index is in translateIndices into natural spoken Sinhala. Return exactly one entry per requested index.",
    translateIndices: input.targetIndices,
    transcript: input.segments.map((s) => ({
      index: s.index,
      time: timestamp(s.startMs),
      text: s.text,
    })),
  };

  const provider = resolveProvider()!;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };
  if (provider.openrouter) {
    headers["HTTP-Referer"] = "https://vidura.nipuntheekshana.com";
    headers["X-Title"] = "Vidura";
  }

  // Headroom per line covers the translation plus the src alignment echo.
  const maxTokens = Math.min(120_000, input.targetIndices.length * 110 + 4000);

  // Abort only on SILENCE: the idle timer resets on every received chunk, so
  // an actively-streaming response can run as long as it needs. The overall
  // cap is just a backstop against a connection that never closes.
  const controller = new AbortController();
  let idleTimer = setTimeout(
    () => controller.abort(),
    STREAM_IDLE_TIMEOUT_MS,
  );
  const overallTimer = setTimeout(() => controller.abort(), STREAM_MAX_MS);

  let content = "";
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model,
        stream: true,
        messages: [
          {
            role: "system",
            content: systemPrompt(input.targetLanguage, input.userGuidance),
          },
          { role: "user", content: JSON.stringify(user) },
        ],
        response_format: provider.jsonSchema
          ? {
            type: "json_schema",
            json_schema: {
              name: "sinhala_subtitles",
              strict: true,
              schema: RESPONSE_SCHEMA,
            },
          }
          : { type: "json_object" },
        // Generous headroom so the output never truncates. OpenAI uses
        // max_completion_tokens; OpenRouter accepts max_tokens.
        ...(provider.openrouter
          ? { max_tokens: maxTokens }
          : { max_completion_tokens: maxTokens }),
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `OpenAI translation failed with ${res.status}: ${detail.slice(0, 400)}`,
      );
    }

    const counter = objectCounter();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => controller.abort(),
          STREAM_IDLE_TIMEOUT_MS,
        );
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let delta: string | undefined;
          try {
            delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          } catch {
            continue;
          }
          if (typeof delta !== "string" || delta.length === 0) continue;
          content += delta;
          const before = counter.count;
          counter.feed(delta);
          if (counter.count !== before) input.onLine(counter.count);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    // A dropped/idle-aborted stream isn't a total loss: whatever complete
    // lines already arrived are salvaged below, and the caller's round loop
    // re-requests only the still-missing indices. Only give up when nothing
    // usable was received.
    const salvaged = salvageTranslations(content);
    if (salvaged.length > 0) return salvaged;
    throw error;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(overallTimer);
  }

  const results = salvageTranslations(content);
  if (results.length === 0) {
    // Log what actually came back so provider flakes are diagnosable.
    console.error(
      "translation parse failure — response head:",
      JSON.stringify(content.slice(0, 300)),
    );
    throw new Error("Translation response was not valid JSON");
  }
  return results;
}

// Parses a complete OR truncated streamed response into translation lines.
// Tries a full parse first, then — for streams cut off mid-object — trims the
// text back to the last fully-closed entry and reconstructs valid JSON for
// each shape the models emit ({"translations":[…]}, bare array, index map).
function salvageTranslations(raw: string): AlignedTranslation[] {
  let text = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  // Some providers prefix prose ("Here are the translations: …") or reasoning
  // before the JSON — cut straight to the first structural character so the
  // parse candidates below start from valid JSON.
  const jsonStart = text.search(/[{[]/);
  if (jsonStart > 0) text = text.slice(jsonStart);
  if (!text) return [];

  // Track string/escape state so braces inside translated text don't count.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastObjEndDepth2 = -1; // "}" closing an item of {"translations":[…]}
  let lastObjEndDepth1 = -1; // "}" closing an item of a bare top-level array
  let lastCommaDepth1 = -1; // "," between entries of an index-keyed map

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (ch === "}" && depth === 2) lastObjEndDepth2 = i;
      if (ch === "}" && depth === 1) lastObjEndDepth1 = i;
    } else if (ch === "," && depth === 1) lastCommaDepth1 = i;
  }

  const candidates = [
    text, // stream finished cleanly
    lastObjEndDepth2 >= 0 ? text.slice(0, lastObjEndDepth2 + 1) + "]}" : null,
    lastObjEndDepth1 >= 0 ? text.slice(0, lastObjEndDepth1 + 1) + "]" : null,
    lastCommaDepth1 >= 0 ? text.slice(0, lastCommaDepth1) + "}" : null,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const results = extractTranslations(JSON.parse(candidate));
      if (results.length > 0) return results;
    } catch {
      // try the next reconstruction
    }
  }
  return [];
}

// Counts JSON array objects as they close in the streamed `{"translations":[…]}`
// response — a small state machine that ignores braces inside strings.
function objectCounter() {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let count = 0;
  return {
    get count() {
      return count;
    },
    feed(chunk: string) {
      for (const ch of chunk) {
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === "{" || ch === "[") {
          depth += 1;
        } else if (ch === "}" || ch === "]") {
          depth -= 1;
          // Each translation object closes at array depth (root{ → [ → obj{).
          if (ch === "}" && depth === 2) count += 1;
        }
      }
    },
  };
}
