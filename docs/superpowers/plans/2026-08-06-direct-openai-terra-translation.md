# Direct OpenAI Terra Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route subtitle translation directly to OpenAI `gpt-5.6-terra` and make exact persisted translation coverage a hard prerequisite for a 100% ready state.

**Architecture:** Keep Vidura's existing Chat Completions structured-output pipeline, but resolve provider configuration explicitly, translate in smaller resumable windows, and validate exact source/translation index-set equality in both the translation layer and worker state machine. Missing Sinhala remains nullable through the API and UI instead of being replaced by English.

**Tech Stack:** Bun, TypeScript, Hono, PostgreSQL, pg-boss, React 19, TanStack Query, OpenAI Chat Completions API, Bun test.

## Global Constraints

- Use `TRANSLATION_PROVIDER=openai`, `OPENAI_MODEL=gpt-5.6-terra`, and a server-only `OPENAI_API_KEY` locally and in production.
- Never print, commit, return, or expose the OpenAI key to frontend code.
- Keep the interactive video chat provider unchanged.
- Never mark a job or video ready unless non-empty translated segment indices exactly equal source transcript segment indices.
- Preserve partial translations as resumable checkpoints.
- Preserve the existing unrelated modification in `server/src/worker.ts`.
- Do not call IAH at runtime.

---

### Task 1: Exact Translation Coverage Boundary

**Files:**
- Create: `server/src/lib/translation-coverage.ts`
- Test: `server/src/lib/translation-coverage.test.ts`

**Interfaces:**
- Produces: `TranslationCoverage`, `IncompleteTranslationError`, `translationCoverage(sourceIndices, translations)`, and `assertCompleteTranslationCoverage(sourceIndices, translations)`.
- Consumes: iterables of source indices and `{ index: number; text: string }` translations.

- [ ] **Step 1: Write failing coverage tests**

Cover an exact match, missing index, unexpected index, duplicate index, and blank translation. Assert that `IncompleteTranslationError` exposes `completed`, `total`, `missingIndices`, `unexpectedIndices`, `duplicateIndices`, and `blankIndices`.

```ts
import { describe, expect, test } from "bun:test";
import {
  assertCompleteTranslationCoverage,
  IncompleteTranslationError,
  translationCoverage,
} from "./translation-coverage.ts";

describe("translationCoverage", () => {
  test("accepts one non-empty translation for every source index", () => {
    expect(translationCoverage([0, 1], [
      { index: 0, text: "පළමු" },
      { index: 1, text: "දෙවන" },
    ]).complete).toBe(true);
  });

  test("reports every form of invalid coverage", () => {
    const coverage = translationCoverage([0, 1, 2], [
      { index: 0, text: "පළමු" },
      { index: 0, text: "නැවත" },
      { index: 1, text: "   " },
      { index: 9, text: "අමතර" },
    ]);
    expect(coverage).toMatchObject({
      complete: false,
      completed: 1,
      total: 3,
      missingIndices: [2],
      unexpectedIndices: [9],
      duplicateIndices: [0],
      blankIndices: [1],
    });
    expect(() => assertCompleteTranslationCoverage([0, 1, 2], [
      { index: 0, text: "පළමු" },
    ])).toThrow(IncompleteTranslationError);
  });
});
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run: `cd server && bun test src/lib/translation-coverage.test.ts`

Expected: FAIL because `translation-coverage.ts` does not exist.

- [ ] **Step 3: Implement coverage analysis and typed failure**

`translationCoverage` must trim text, count only valid expected indices as completed, sort diagnostic arrays numerically, and define `complete` only when all diagnostic arrays are empty and `completed === total`. `assertCompleteTranslationCoverage` returns the coverage when complete and throws `IncompleteTranslationError` otherwise.

- [ ] **Step 4: Run the focused test**

Run: `cd server && bun test src/lib/translation-coverage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the coverage boundary**

```bash
git add server/src/lib/translation-coverage.ts server/src/lib/translation-coverage.test.ts
git commit -m "test: add translation coverage invariant"
```

---

### Task 2: Explicit OpenAI Provider Configuration

**Files:**
- Create: `server/src/lib/translation-provider.ts`
- Test: `server/src/lib/translation-provider.test.ts`
- Modify: `server/src/env.ts`
- Modify: `server/src/lib/openai.ts`
- Modify: `server/.env.example`
- Modify locally without staging: `server/.env`

**Interfaces:**
- Produces: `resolveTranslationProviderConfig(input): TranslationProviderConfig`.
- Consumes: provider name plus OpenAI/OpenRouter keys and model names.
- `openai.ts` consumes the resolved URL, key, model, schema mode, and OpenRouter header flag.

- [ ] **Step 1: Write failing provider tests**

Test that OpenAI resolves to `https://api.openai.com/v1/chat/completions`, Terra, strict schema, and no OpenRouter headers; missing OpenAI key throws an explicit error even if an OpenRouter key exists; DeepSeek resolves only when intentionally selected; unknown provider throws.

```ts
expect(resolveTranslationProviderConfig({
  provider: "openai",
  openaiApiKey: "test-openai-key",
  openaiModel: "gpt-5.6-terra",
  openRouterApiKey: "test-router-key",
  openRouterModel: "deepseek/model",
})).toMatchObject({
  model: "gpt-5.6-terra",
  jsonSchema: true,
  openrouter: false,
});
```

- [ ] **Step 2: Run the provider test and verify failure**

Run: `cd server && bun test src/lib/translation-provider.test.ts`

Expected: FAIL because the provider resolver module does not exist.

- [ ] **Step 3: Implement the pure resolver and connect it to `openai.ts`**

Make `resolveProvider()` call the pure resolver with `env` values. `singleShotTranslationEnabled()` must resolve or throw; it must not return false and enter the batched OpenRouter path when the selected provider is misconfigured.

- [ ] **Step 4: Select Terra in defaults and untracked local configuration**

Change `OPENAI_MODEL` default and example to `gpt-5.6-terra`, change the example provider to `openai`, and update only `OPENAI_MODEL` and `TRANSLATION_PROVIDER` in `server/.env`. Preserve the existing secret value and verify presence only with a boolean/length check.

- [ ] **Step 5: Run provider and coverage tests**

Run: `cd server && bun test src/lib/translation-provider.test.ts src/lib/translation-coverage.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit provider configuration**

```bash
git add server/src/env.ts server/src/lib/openai.ts server/src/lib/translation-provider.ts server/src/lib/translation-provider.test.ts server/.env.example
git commit -m "feat: select direct OpenAI Terra translation"
```

Do not stage `server/.env`.

---

### Task 3: Resumable Terra Calls and Complete Results

**Files:**
- Modify: `server/src/lib/openai.ts`
- Test: `server/src/lib/openai-stream.test.ts`

**Interfaces:**
- Consumes: `assertCompleteTranslationCoverage` from Task 1 and provider configuration from Task 2.
- Produces: `translateTranscriptOpenAI` that returns only complete transcript coverage or throws `IncompleteTranslationError` after preserving partial results.
- Produces a pure exported-for-test SSE event parser that distinguishes content deltas, finish reasons, request metadata, and provider errors.
- Produces: `finalizeTranslationResults(sourceIndices: number[], byIndex: ReadonlyMap<number, string>): TranslationResult[]`, which orders results and enforces exact coverage without making an API request.

- [ ] **Step 1: Write failing stream and completeness tests**

Test parsing a content delta, `finish_reason: "length"`, and `{ "error": { "message": "rate limited" } }`. Test that `finalizeTranslationResults([0, 1], new Map([[0, "පළමු"]]))` throws `IncompleteTranslationError`, so no paid request occurs.

```ts
expect(parseTranslationStreamPayload(JSON.stringify({
  id: "chatcmpl_test",
  choices: [{ delta: { content: "{\"translations\":[" }, finish_reason: null }],
}))).toMatchObject({ content: "{\"translations\":[", responseId: "chatcmpl_test" });

expect(() => parseTranslationStreamPayload(JSON.stringify({
  error: { message: "rate limited" },
}))).toThrow("rate limited");
```

- [ ] **Step 2: Run the stream test and verify failure**

Run: `cd server && bun test src/lib/openai-stream.test.ts`

Expected: FAIL because the parser/helper exports do not exist.

- [ ] **Step 3: Implement conservative OpenAI request behavior**

Set `MAX_LINES_PER_CALL` to 100. Add `reasoning_effort: "low"` only for direct OpenAI requests. Keep `max_completion_tokens` for OpenAI and `max_tokens` for OpenRouter.

- [ ] **Step 4: Handle SSE errors and finish reasons**

Parse every JSON SSE payload once. Throw on top-level provider errors, collect response ID/model/finish reason for safe diagnostics, append only string content deltas, and log a non-secret diagnostic when a stream terminates for a reason other than `stop`.

- [ ] **Step 5: Retry no-progress rounds and enforce final completeness**

Do not break after the first round that adds zero lines; exhaust the existing four-round bound. Build the ordered output, call `assertCompleteTranslationCoverage`, and throw the typed error when any source index is missing. Continue invoking `onRoundResults` per successful window so retries resume.

- [ ] **Step 6: Run focused tests**

Run: `cd server && bun test src/lib/openai-stream.test.ts src/lib/translation-coverage.test.ts src/lib/translation-provider.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit reliable OpenAI calls**

```bash
git add server/src/lib/openai.ts server/src/lib/openai-stream.test.ts
git commit -m "fix: require complete Terra translation output"
```

---

### Task 4: Guard the Worker Ready Transition

**Files:**
- Modify: `server/src/jobs/process-video.ts`
- Test: `server/src/jobs/process-video-state.test.ts`
- Create: `server/src/jobs/process-video-state.ts`

**Interfaces:**
- Consumes: `assertCompleteTranslationCoverage` and `IncompleteTranslationError` from Task 1.
- Produces: `failureState(error, currentProgress)` returning progress below 100 and diagnostic metadata for incomplete translations.
- The worker independently reloads persisted translations before setting ready.

- [ ] **Step 1: Write failing state tests**

Test that an `IncompleteTranslationError` for 8/246 produces failed state with progress below 100, `translated_segments: 8`, `remaining_segments: 238`, and missing indices. Test that an unrelated error preserves the current progress capped at 99.

```ts
const state = failureState(
  new IncompleteTranslationError({
    complete: false,
    completed: 8,
    total: 246,
    missingIndices: Array.from({ length: 238 }, (_, i) => i + 8),
    unexpectedIndices: [],
    duplicateIndices: [],
    blankIndices: [],
  }),
  27,
);
expect(state.progress).toBeLessThan(100);
expect(state.metadata).toMatchObject({
  translated_segments: 8,
  remaining_segments: 238,
});
```

- [ ] **Step 2: Run the state test and verify failure**

Run: `cd server && bun test src/jobs/process-video-state.test.ts`

Expected: FAIL because `process-video-state.ts` does not exist.

- [ ] **Step 3: Implement pure failure-state mapping**

Limit stored/logged missing-index diagnostics to the first 50 indices while retaining exact counts. General failures use `Math.min(99, Math.max(0, currentProgress))`.

- [ ] **Step 4: Add the database-backed ready gate**

After either translation path finishes, reload translations, run exact coverage validation, set `translatedCount` from validated persisted data, then write model attribution and ready state. Ready metadata includes `remaining_segments: 0` and `translation_coverage: 100`.

- [ ] **Step 5: Preserve real failure progress**

In the catch block, load the current processing-job progress, map the failure through `failureState`, persist its metadata, and never assign progress 100 for failure. The ready notification remains after the guarded ready transition.

- [ ] **Step 6: Run focused tests and server typecheck**

Run: `cd server && bun test src/jobs/process-video-state.test.ts src/lib/translation-coverage.test.ts && bunx tsc --noEmit`

Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit state-machine protection**

```bash
git add server/src/jobs/process-video.ts server/src/jobs/process-video-state.ts server/src/jobs/process-video-state.test.ts
git commit -m "fix: block ready state for partial translations"
```

---

### Task 5: Stop Presenting English as Sinhala

**Files:**
- Create: `server/src/lib/subtitle-response.ts`
- Test: `server/src/lib/subtitle-response.test.ts`
- Modify: `server/src/routes/videos.ts`
- Modify: `src/features/videos/data.ts`
- Modify: `src/app/App.tsx`

**Interfaces:**
- Produces: `buildSubtitleResponse(segments, translations)` with `sinhala: string | null`.
- Frontend `TranscriptSegment.sinhala` consumes `string | null`.

- [ ] **Step 1: Write the failing subtitle-response test**

Assert that translated rows contain Sinhala and missing rows contain `null`, never their English source text.

```ts
expect(buildSubtitleResponse(
  [{ id: "a", start_ms: 0, end_ms: 1000, text: "English" }],
  [],
)).toEqual([{
  id: "a",
  time: "00:00",
  startMs: 0,
  endMs: 1000,
  original: "English",
  sinhala: null,
}]);
```

- [ ] **Step 2: Run the response test and verify failure**

Run: `cd server && bun test src/lib/subtitle-response.test.ts`

Expected: FAIL because `subtitle-response.ts` does not exist.

- [ ] **Step 3: Implement and use the response builder**

Move only the pure response mapping into `subtitle-response.ts`; keep ownership and SQL concerns in the Hono route. Pass fetched segments and translations to the builder.

- [ ] **Step 4: Update nullable frontend behavior**

Change `TranscriptSegment.sinhala` to `string | null`. Keep the video overlay empty during a missing silent/translation gap, show the existing global failure message when the job failed, and render “Translation unavailable” for a missing transcript-row translation. In bilingual mode, the explicit English row remains visible.

- [ ] **Step 5: Separate timing and translation labels**

Rename the timing badge from `Sync N%` to `Timing N%`. Add a translation coverage badge computed from `latestJob.metadata.translated_segments / total_segments`, so historical partial-ready records are visibly not fully translated.

- [ ] **Step 6: Run server test and frontend build**

Run: `cd server && bun test src/lib/subtitle-response.test.ts`

Run: `bun run build`

Expected: test PASS and production build exits 0.

- [ ] **Step 7: Commit presentation correction**

```bash
git add server/src/lib/subtitle-response.ts server/src/lib/subtitle-response.test.ts server/src/routes/videos.ts src/features/videos/data.ts src/app/App.tsx
git commit -m "fix: expose missing Sinhala translations honestly"
```

---

### Task 6: Full Local Verification

**Files:**
- Modify only if verification reveals a defect in the files already listed above.

**Interfaces:**
- Consumes all prior tasks.
- Produces a locally verified candidate with no secret staged.

- [ ] **Step 1: Run the complete server test suite**

Run: `cd server && bun test`

Expected: all tests PASS without network calls.

- [ ] **Step 2: Run server typecheck**

Run: `cd server && bunx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 3: Run frontend production build**

Run: `bun run build`

Expected: exit 0.

- [ ] **Step 4: Audit secret and diff boundaries**

Run: `git status --short && git diff --check && git grep -n "sk-" -- ':!docs/superpowers/**' || true`

Expected: `server/.env` is not staged/tracked, no secret-like key was introduced, and the original worktree's unrelated `server/src/worker.ts` modification remains outside this feature branch/worktree.

- [ ] **Step 5: Commit any verification-only corrections**

If verification required a correction, stage only its exact files and use a supported `fix:` or `test:` commit message. If no correction was needed, do not create an empty commit.

---

### Task 7: Production Configuration, Deployment, and Smoke Test

**Files:**
- Modify on VPS, untracked: `/opt/vidura/server/.env` (resolve actual deployment directory read-only before editing)
- Deploy: verified server/frontend files according to the existing Vidura deployment process

**Interfaces:**
- Consumes the locally verified branch and the existing non-empty local OpenAI key.
- Produces running API/worker containers configured for direct Terra translation.

- [ ] **Step 1: Resolve and back up production targets**

Use read-only SSH checks to confirm the deployment directory, Compose project, current git/image state, and whether `OPENAI_API_KEY` is non-empty without printing its value. Copy the production `.env` to a timestamped mode-600 backup before mutation.

- [ ] **Step 2: Set production environment values securely**

Set `TRANSLATION_PROVIDER=openai` and `OPENAI_MODEL=gpt-5.6-terra`. If the production OpenAI key is absent, transmit the existing local value through stdin without placing it in command arguments, terminal output, logs, or repository files.

- [ ] **Step 3: Deploy and restart**

Deploy only the verified files, rebuild the server image, and restart API and worker with Docker Compose. Confirm health and worker queue consumption from container status/logs.

- [ ] **Step 4: Verify effective configuration safely**

Inside the worker container, print only booleans/model/provider: key present, model equals `gpt-5.6-terra`, provider equals `openai`. Never print the key.

- [ ] **Step 5: Run a short-video smoke test**

Regenerate an existing short video through the normal job route or queue. Query PostgreSQL for source count, non-empty Sinhala count, status, progress, and model attribution. Expected: counts equal, status `ready`, progress 100, model `gpt-5.6-terra`.

- [ ] **Step 6: Run the reported long-video regression**

Regenerate video `6d22ffa3-af12-4c8b-86af-1cc1fae9157b`. Monitor worker logs and database counts until terminal state. Expected: 246 source rows, 246 non-empty Sinhala rows, ready/100 only after equality, and Terra attribution. If OpenAI fails, expected safe behavior is failed with progress below 100 and accurate missing-count metadata—not false readiness.

- [ ] **Step 7: Report deployment and rollback state**

Report container health, tested video counts/statuses, model attribution, elapsed/cost data if returned, the environment-backup path, and whether rollback was necessary. Do not include secret values.
