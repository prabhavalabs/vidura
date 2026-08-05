# Direct OpenAI Terra Translation Design

## Goal

Move Vidura's subtitle translation from DeepSeek through OpenRouter to OpenAI's API directly, using `gpt-5.6-terra`, while eliminating the condition where a partially translated video is reported as ready at 100%.

Success means all of the following are true:

- Vidura's worker calls `api.openai.com` directly for subtitle translation.
- The OpenAI key is read only from server-side environment configuration.
- A video cannot enter the `ready` state unless every source segment has a non-empty, aligned Sinhala translation.
- Missing translations are visible as missing data, never disguised by returning the English source as Sinhala.
- Transient provider and malformed-response failures remain resumable and diagnosable.

## Scope

This change covers the background subtitle-translation pipeline, its environment configuration, completion reporting, missing-subtitle API behavior, focused automated tests, and production configuration.

The existing video chat feature remains on its current provider. Moving chat to OpenAI is a separate decision because it has different prompt, streaming, cost, and retrieval requirements.

## Chosen Approach

Use OpenAI directly with `gpt-5.6-terra` as the sole selected translation provider in local and production configuration. Retain the existing provider abstraction for an intentional rollback, but never silently fall back to OpenRouter when OpenAI is selected and its key is absent.

Terra is the initial quality baseline. A Luna primary/Terra repair strategy is deferred until Vidura has representative English-to-Sinhala evaluation data; adding routing before that evidence would add complexity without proving a product benefit.

## Credential and Configuration Architecture

IAH is only the existing source from which the owner obtains the key. Vidura never calls IAH at runtime and never exposes the key to the browser.

The credential flow is:

1. Copy the existing key once into `server/.env` for local development.
2. Copy the same key into the untracked `server/.env` on the production VPS.
3. Docker Compose injects that file into the API and worker containers.
4. Only the worker uses the key for translation calls.

The selected settings are:

```text
TRANSLATION_PROVIDER=openai
OPENAI_MODEL=gpt-5.6-terra
```

`OPENAI_API_KEY` is set to the actual secret in each untracked server environment file; the value is never written in repository documentation or examples.

The repository's example environment file will document these defaults without containing a secret. If `TRANSLATION_PROVIDER=openai` is selected but `OPENAI_API_KEY` is empty, translation fails with an explicit configuration error. It must not enter the legacy OpenRouter translation branch.

## Translation Data Flow

1. The worker loads or creates the ordered English transcript.
2. It loads previously persisted Sinhala rows so retries resume from the first missing segment.
3. Missing segments are divided into conservative request windows rather than asking for hundreds of translated objects in one response.
4. Every request includes whole-video context and asks OpenAI for strict JSON-schema output containing one `index`, source echo, and Sinhala text per requested segment.
5. Each returned source echo is checked against the source segment before the translation can be persisted.
6. Valid windows are persisted immediately, so a worker restart loses at most the active window.
7. Missing or rejected indices are retried through a bounded number of rounds.
8. The worker queries persisted translations again and enforces the completion invariant before setting the video ready.

The completion invariant is:

```text
non-empty translated segment indices == source transcript segment indices
```

Checking only the number of returned objects is insufficient; the exact index sets must match.

## Provider Request Behavior

The first implementation keeps Chat Completions because Vidura already has a working direct-OpenAI structured-output path and translation is a stateless operation. Migrating to the Responses API would not itself solve completeness and would unnecessarily combine an API migration with the reliability correction.

OpenAI requests use:

- Model `gpt-5.6-terra`.
- Strict JSON Schema rather than JSON mode.
- Low reasoning effort because subtitle translation is constrained generation, not open-ended analysis.
- Smaller translation windows to reduce response truncation and make retries inexpensive.
- Existing idle and overall connection safeguards.

The stream parser records provider error events and finish reasons instead of silently ignoring non-content SSE payloads. A truncated response may contribute fully parsed, aligned objects, but the job remains incomplete until all missing indices are subsequently filled.

## Completion, Progress, and Error Handling

Partial output is a checkpoint, not success.

If retries end with missing indices, the translation layer raises a typed incomplete-translation error containing completed count, total count, and a bounded list of missing indices. The worker persists those counts in job metadata, keeps progress below 100, sets the job/video to failed, and does not send the “subtitles ready” notification.

Before the ready transition, the worker independently reloads translated rows from PostgreSQL and checks the exact coverage invariant. This second check protects the state machine even if the provider layer later changes.

The existing timing quality score remains distinct from translation coverage. A subtitle track may be synchronized 100% while translation is incomplete. The processing state and metadata remain the authority for whether Sinhala subtitles are ready.

Expected failures and handling:

- Missing key: explicit configuration failure before a provider call.
- HTTP authentication/rate/server failure: logged with HTTP status and safe response detail; resumable job failure.
- Idle or maximum-duration abort: salvage only complete aligned objects, then retry missing indices.
- SSE provider error: surface the provider message and request identifier where available.
- Invalid or truncated JSON: salvage complete objects, then retry; never mark ready from the salvage alone.
- Misaligned source echo: reject that object and retry its index.
- Exhausted retries: typed incomplete failure with actual coverage.

## Subtitle API and UI Behavior

The subtitle endpoint will represent an untranslated Sinhala line as absent instead of copying `segment.text` into the Sinhala field. The frontend will therefore show loading while translation is active, a clear failure message when the job failed, or no Sinhala line for a genuinely missing translation. Bilingual mode may still show the English source in its explicit English row, but the Sinhala row must never contain an implicit English fallback.

Provider attribution comes from the persisted translation model and will display Terra after successful processing. Existing videos keep their historical attribution unless regenerated.

## Testing Strategy

Focused server tests will cover the correctness boundary without making paid API calls:

- Exact source and translated index sets pass coverage validation.
- Missing, extra, duplicate, and blank translations fail validation.
- Partial translation output cannot produce a ready transition.
- Selected OpenAI provider without a key produces an explicit configuration error rather than OpenRouter fallback.
- Missing translations from the subtitle API are represented as absent, not English text.

Static verification includes the server TypeScript check and the frontend production build. A production smoke test will regenerate one short video first, verify every row is translated and attributed to Terra, then retry the reported long video and compare source/translation counts before considering deployment complete.

No test or smoke-check output may print the API key.

## Deployment and Rollback

Deployment order:

1. Back up the production environment file.
2. Set `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5.6-terra`, and `TRANSLATION_PROVIDER=openai` in the VPS `server/.env`.
3. Deploy the verified server image and restart the API and worker.
4. Confirm both containers received non-empty configuration without printing the value.
5. Run the short-video smoke test, followed by the original long-video regression test.

Rollback restores the previous production environment values and server image. Already persisted Terra translations remain valid data; rollback does not delete translations or transcripts.

## Non-Goals

- Migrating the interactive chat feature from OpenRouter.
- Introducing Luna routing before quality evaluation.
- Storing or retrieving the key through IAH at runtime.
- Committing any `.env` file or secret.
- Rewriting unrelated transcript acquisition or UI architecture.
