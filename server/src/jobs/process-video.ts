import { sql } from "../db.ts";
import { env } from "../env.ts";
import {
  consolidateSegments,
  fetchYouTubeMetadata,
  fetchYouTubeVideoData,
  type NormalizedTranscriptSegment,
} from "../lib/youtube.ts";
import {
  buildPriorTranslations,
  buildTranslationContext,
  chunkSegments,
  parseTranslationContext,
  translateCompleteBatch,
  TRANSLATION_BATCH_SIZE,
  type TranslationContext,
} from "../lib/translation.ts";
import {
  buildTranslationContextOpenAI,
  singleShotTranslationEnabled,
  translateTranscriptOpenAI,
  translationModelName,
} from "../lib/openai.ts";
import { assertCompleteTranslationCoverage } from "../lib/translation-coverage.ts";
import { fetchTranslationSettings } from "../lib/translation-settings.ts";
import {
  assessSubtitleQuality,
  type SubtitleSource,
} from "../lib/subtitle-quality.ts";
import { sendPushToOwner } from "../lib/push.ts";
import type { ProcessVideoJobData } from "./boss.ts";
import {
  failureState,
  resolveTranslationContext,
} from "./process-video-state.ts";

type StoredSegment = {
  id: string;
  segment_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
};

type JobState = {
  jobStatus: "running" | "ready" | "failed";
  videoStatus: "fetching_transcript" | "translating" | "ready" | "failed";
  progress: number;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
};

// Runs the full transcript + translation pipeline. Unlike the edge function
// this has no wall-clock kill limit, so it simply runs to completion.
export async function runProcessVideoJob(data: ProcessVideoJobData) {
  const jobId = data.jobId;
  const videoId = data.videoId;

  try {
    const [video] = await sql<
      Array<{
        youtube_video_id: string;
        title: string;
        channel_title: string | null;
        duration_ms: number | null;
        metadata: Record<string, unknown>;
      }>
    >`
      select youtube_video_id, title, channel_title, duration_ms, metadata
      from videos where id = ${videoId}
    `;
    if (!video) throw new Error("Video for processing job was not found");

    if (data.forceRefetchTranscript) {
      await updateJob(jobId, videoId, {
        jobStatus: "running",
        videoStatus: "fetching_transcript",
        progress: 2,
        metadata: { stage: "clearing_transcript", translated_segments: 0 },
      });
      await sql`delete from transcript_segments where video_id = ${videoId}`;
    }

    let stored = await fetchStoredSegments(videoId);
    let transcriptSegments = stored.map(toNormalized);

    if (transcriptSegments.length === 0) {
      await updateJob(jobId, videoId, {
        jobStatus: "running",
        videoStatus: "fetching_transcript",
        progress: 5,
        metadata: { stage: "fetching_metadata", translated_segments: 0 },
      });

      const uploaded = normalizeSegments(data.segments);
      // When the client supplies the transcript (browser userscript or file
      // upload), it also supplies the metadata, already written to the video
      // row at ingest time — so no YouTube network call is made at all. A
      // null-metadata object below keeps the existing row values via coalesce.
      // Otherwise Gemini fetches the transcript and the Data API/oembed the
      // metadata.
      const ytData = uploaded.length > 0
        ? null
        : await fetchYouTubeVideoData(video.youtube_video_id);
      const metadata = ytData?.metadata ?? (uploaded.length > 0
        ? { title: null, channelTitle: null, durationMs: null, thumbnailUrl: null }
        : await fetchYouTubeMetadata(video.youtube_video_id));

      await sql`
        update videos set
          thumbnail_url = coalesce(${metadata.thumbnailUrl}, thumbnail_url,
            ${"https://i.ytimg.com/vi/" + video.youtube_video_id + "/hqdefault.jpg"}),
          title = coalesce(${metadata.title}, title),
          channel_title = coalesce(${metadata.channelTitle}, channel_title),
          duration_ms = coalesce(${metadata.durationMs}, duration_ms),
          source_language = ${data.sourceLanguage},
          metadata = metadata || ${sql.json({
        youtube_metadata_fetched_at: new Date().toISOString(),
      })}
        where id = ${videoId}
      `;

      // Merge short caption cues into sentence-level lines — readable pacing
      // for viewers, complete sentences for the translator. Applied uniformly
      // to every source (captions, Gemini ASR, uploaded files).
      transcriptSegments = consolidateSegments(
        uploaded.length > 0 ? uploaded : ytData!.segments,
      );

      if (transcriptSegments.length === 0) {
        throw new Error("No transcript segments were available for this video");
      }

      // "ytdlp" = frame-accurate YouTube captions, "gemini" = drift-prone
      // audio ASR. Surfaced so out-of-sync reports are traceable to source.
      const transcriptSource: SubtitleSource = uploaded.length > 0
        ? "uploaded"
        : ytData?.source ?? "gemini";

      await updateJob(jobId, videoId, {
        jobStatus: "running",
        videoStatus: "fetching_transcript",
        progress: 20,
        metadata: {
          stage: "storing_transcript",
          total_segments: transcriptSegments.length,
          translated_segments: 0,
          transcript_source: transcriptSource,
        },
      });

      stored = await storeTranscript(
        videoId,
        data.sourceLanguage,
        transcriptSegments,
      );

      // Score the timings (ordering, overlap, runtime coverage + source
      // confidence) and persist source + score on the video for the UI.
      const quality = assessSubtitleQuality(
        transcriptSegments,
        metadata.durationMs ?? video.duration_ms,
        transcriptSource,
      );
      await sql`
        update videos set metadata = metadata || ${sql.json({
        transcript_source: transcriptSource,
        subtitle_quality: quality,
      })}
        where id = ${videoId}
      `;
    } else {
      // Transcript was already stored (e.g. re-translate). Backfill the
      // quality score for videos processed before scoring existed, using the
      // recorded source when available.
      const knownSource = video.metadata?.transcript_source;
      if (
        !video.metadata?.subtitle_quality &&
        (knownSource === "ytdlp" || knownSource === "gemini" ||
          knownSource === "uploaded")
      ) {
        const quality = assessSubtitleQuality(
          transcriptSegments,
          video.duration_ms,
          knownSource,
        );
        await sql`
          update videos set metadata = metadata || ${sql.json({
          subtitle_quality: quality,
        })}
          where id = ${videoId}
        `;
      }
    }

    if (data.forceRetranslate) {
      await sql`
        delete from translated_segments
        where video_id = ${videoId} and language_code = ${data.targetLanguage}
      `;
    }

    const segmentIdByIndex = new Map(stored.map((s) => [s.segment_index, s.id]));
    const existingTranslations = await fetchExistingTranslations(
      videoId,
      data.targetLanguage,
    );
    const untranslated = transcriptSegments.filter(
      (segment) => !existingTranslations.has(segment.index),
    );
    let translatedCount = transcriptSegments.length - untranslated.length;
    const useSingleShotTranslation = singleShotTranslationEnabled();
    const translationSettings = useSingleShotTranslation
      ? await fetchTranslationSettings(data.ownerId)
      : null;
    let translationContext: TranslationContext | null = null;

    if (untranslated.length > 0) {
      const [jobRow] = await sql<Array<{ metadata: Record<string, unknown> }>>`
        select metadata from processing_jobs where id = ${jobId}
      `;
      const jobMetadata = jobRow?.metadata ?? {};
      translationContext = await resolveTranslationContext({
        existing: parseTranslationContext(jobMetadata.translation_context),
        rebuild: Boolean(data.rebuildContext),
        build: async () => {
          await updateJob(jobId, videoId, {
            jobStatus: "running",
            videoStatus: "translating",
            progress: translationProgress(
              translatedCount,
              transcriptSegments.length,
            ),
            metadata: {
              stage: "building_translation_context",
              translator: useSingleShotTranslation
                ? translationModelName()
                : env.openRouterModel,
              total_segments: transcriptSegments.length,
              translated_segments: translatedCount,
            },
          });
          return useSingleShotTranslation
            ? buildTranslationContextOpenAI({
              sourceLanguage: data.sourceLanguage,
              targetLanguage: data.targetLanguage,
              videoTitle: video.title,
              channelTitle: video.channel_title,
              segments: transcriptSegments,
              userGuidance: translationSettings?.systemPrompt,
            })
            : buildTranslationContext({
              model: env.openRouterModel,
              sourceLanguage: data.sourceLanguage,
              targetLanguage: data.targetLanguage,
              videoTitle: video.title,
              channelTitle: video.channel_title,
              segments: transcriptSegments,
            });
        },
        persist: (context) =>
          mergeJobMetadata(jobId, { translation_context: context }),
      });
    }

    if (useSingleShotTranslation) {
      // Bounded structured-output windows translate the transcript with the
      // same full-video context and glossary, streamed for live progress.
      await updateJob(jobId, videoId, {
        jobStatus: "running",
        videoStatus: "translating",
        progress: translationProgress(translatedCount, transcriptSegments.length),
        metadata: {
          stage: "translating",
          translator: translationModelName(),
          total_segments: transcriptSegments.length,
          translated_segments: translatedCount,
        },
      });

      const total = transcriptSegments.length;
      let lastProgress = -1;
      const results = await translateTranscriptOpenAI({
        segments: transcriptSegments,
        metadata: { title: video.title, channelTitle: video.channel_title },
        targetLanguage: data.targetLanguage,
        translationContext: translationContext ?? undefined,
        userGuidance: translationSettings?.systemPrompt,
        // Resume from lines stored by an earlier attempt of this job instead
        // of re-translating the whole video after a crash or restart.
        seed: existingTranslations,
        // Persist each round as soon as it lands so a mid-run failure keeps
        // its progress for the next attempt.
        onRoundResults: (roundResults) =>
          storeTranslations(
            videoId,
            data.targetLanguage,
            translationModelName(),
            segmentIdByIndex,
            roundResults,
          ),
        // Each finished line streams in — push a granular progress update
        // (throttled to whole-percent changes) so the client bar moves live.
        onProgress: (done) => {
          const progress = translationProgress(done, total);
          if (progress === lastProgress) return;
          lastProgress = progress;
          void updateJob(jobId, videoId, {
            jobStatus: "running",
            videoStatus: "translating",
            progress,
            metadata: {
              stage: "translating",
              translator: translationModelName(),
              total_segments: total,
              translated_segments: done,
              remaining_segments: total - done,
              current_segment_text: transcriptSegments[done]?.text ?? null,
            },
          }).catch(() => {});
        },
      });
      await storeTranslations(
        videoId,
        data.targetLanguage,
        translationModelName(),
        segmentIdByIndex,
        results,
      );
      translatedCount = (await fetchExistingTranslations(
        videoId,
        data.targetLanguage,
      )).size;
    } else {
      const translationsByIndex = new Map(existingTranslations);
      const batches = chunkSegments(untranslated, TRANSLATION_BATCH_SIZE);

      for (const batch of batches) {
        const current = batch[0];
        await updateJob(jobId, videoId, {
          jobStatus: "running",
          videoStatus: "translating",
          progress: translationProgress(
            translatedCount,
            transcriptSegments.length,
          ),
          metadata: {
            stage: "translating",
            total_segments: transcriptSegments.length,
            translated_segments: translatedCount,
            remaining_segments: transcriptSegments.length - translatedCount,
            current_segment_index: current?.index,
            current_segment_start_ms: current?.startMs,
            current_segment_text: current?.text,
          },
        });

        const batchTranslations = await translateCompleteBatch({
          model: env.openRouterModel,
          sourceLanguage: data.sourceLanguage,
          targetLanguage: data.targetLanguage,
          segments: batch,
          allSegments: transcriptSegments,
          translationContext: translationContext!,
          videoTitle: video.title,
          channelTitle: video.channel_title,
          priorTranslations: buildPriorTranslations(batch, translationsByIndex),
        });

        await storeTranslations(
          videoId,
          data.targetLanguage,
          env.openRouterModel,
          segmentIdByIndex,
          batchTranslations,
        );

        for (const t of batchTranslations) {
          translationsByIndex.set(t.index, t.text);
        }
        translatedCount += batchTranslations.length;
      }
    }

    // Treat the database as the final authority. Provider output is only a
    // checkpoint until every current transcript index has a persisted,
    // non-empty translation.
    const persistedTranslations = await fetchExistingTranslations(
      videoId,
      data.targetLanguage,
    );
    const coverage = assertCompleteTranslationCoverage(
      transcriptSegments.map((segment) => segment.index),
      [...persistedTranslations].map(([index, text]) => ({ index, text })),
    );
    translatedCount = coverage.completed;

    // Record which model produced the subtitles so the UI can attribute them.
    await sql`
      update videos set metadata = metadata || ${sql.json({
      translation_model: useSingleShotTranslation
        ? translationModelName()
        : env.openRouterModel,
    })}
      where id = ${videoId}
    `;

    await updateJob(jobId, videoId, {
      jobStatus: "ready",
      videoStatus: "ready",
      progress: 100,
      metadata: {
        stage: "ready",
        total_segments: transcriptSegments.length,
        translated_segments: translatedCount,
        remaining_segments: 0,
        translation_coverage: 100,
      },
    });

    await sendPushToOwner(data.ownerId, {
      title: "Subtitles ready 🎬",
      body: `"${video.title}" is translated and ready to watch.`,
      url: `/watch/${videoId}`,
      tag: `video-${videoId}`,
    }).catch(() => {});
  } catch (error) {
    let currentProgress = 0;
    try {
      const [currentJob] = await sql<Array<{ progress: number }>>`
        select progress from processing_jobs where id = ${jobId}
      `;
      currentProgress = currentJob?.progress ?? 0;
    } catch {
      // Preserve the original processing failure if progress lookup also fails.
    }
    const failed = failureState(error, currentProgress);
    await updateJob(jobId, videoId, {
      jobStatus: "failed",
      videoStatus: "failed",
      progress: failed.progress,
      errorMessage: failed.errorMessage,
      metadata: failed.metadata,
    });
    throw error;
  }
}

async function updateJob(jobId: string, videoId: string, state: JobState) {
  const now = new Date().toISOString();
  const patch = state.metadata ?? {};

  await sql`
    update processing_jobs set
      status = ${state.jobStatus},
      progress = ${state.progress},
      error_message = ${state.errorMessage ?? null},
      metadata = metadata || ${sql.json(patch as never)},
      started_at = case when ${state.jobStatus} = 'running' then coalesce(started_at, ${now}) else started_at end,
      finished_at = case when ${state.jobStatus} <> 'running' then ${now} else finished_at end
    where id = ${jobId}
  `;
  await sql`
    update videos set status = ${state.videoStatus},
      error_message = ${state.errorMessage ?? null}
    where id = ${videoId}
  `;
}

async function mergeJobMetadata(jobId: string, patch: Record<string, unknown>) {
  await sql`
    update processing_jobs set metadata = metadata || ${sql.json(patch as never)}
    where id = ${jobId}
  `;
}

async function fetchStoredSegments(videoId: string): Promise<StoredSegment[]> {
  return await sql<StoredSegment[]>`
    select id, segment_index, start_ms, end_ms, text
    from transcript_segments where video_id = ${videoId}
    order by segment_index asc
  `;
}

function toNormalized(segment: StoredSegment): NormalizedTranscriptSegment {
  return {
    index: segment.segment_index,
    startMs: segment.start_ms,
    endMs: segment.end_ms,
    text: segment.text,
  };
}

function normalizeSegments(
  segments: ProcessVideoJobData["segments"],
): NormalizedTranscriptSegment[] {
  return segments
    .map((segment, index) => ({
      index,
      startMs: Math.max(0, Math.floor(segment.startMs ?? index * 5000)),
      endMs: Math.max(1, Math.floor(segment.endMs ?? index * 5000 + 4500)),
      text: segment.text?.trim() ?? "",
    }))
    // Unbounded on purpose: consolidateSegments applies the pipeline's single
    // length cap. Capping at 500 here threw away everything past roughly the
    // first half hour of an uploaded transcript.
    .filter((segment) => segment.text && segment.endMs > segment.startMs);
}

async function storeTranscript(
  videoId: string,
  sourceLanguage: string,
  segments: NormalizedTranscriptSegment[],
): Promise<StoredSegment[]> {
  const rows = segments.map((segment) => ({
    video_id: videoId,
    segment_index: segment.index,
    start_ms: segment.startMs,
    end_ms: segment.endMs,
    source_language: sourceLanguage,
    text: segment.text,
    normalized_text: segment.text.toLowerCase(),
  }));

  await sql`
    insert into transcript_segments ${sql(rows)}
    on conflict (video_id, segment_index) do update set
      start_ms = excluded.start_ms, end_ms = excluded.end_ms,
      source_language = excluded.source_language, text = excluded.text,
      normalized_text = excluded.normalized_text
  `;

  return await fetchStoredSegments(videoId);
}

async function fetchExistingTranslations(videoId: string, targetLanguage: string) {
  const rows = await sql<Array<{ segment_index: number; text: string }>>`
    select ts.segment_index, tr.text
    from translated_segments tr
    join transcript_segments ts on ts.id = tr.segment_id
    where tr.video_id = ${videoId} and tr.language_code = ${targetLanguage}
  `;
  const map = new Map<number, string>();
  for (const row of rows) {
    if (row.text.trim()) map.set(row.segment_index, row.text.trim());
  }
  return map;
}

async function storeTranslations(
  videoId: string,
  targetLanguage: string,
  model: string,
  segmentIdByIndex: Map<number, string>,
  translations: Array<{ index: number; text: string }>,
) {
  const rows = translations.flatMap((translation) => {
    const segmentId = segmentIdByIndex.get(translation.index);
    if (!segmentId) return [];
    return [{
      segment_id: segmentId,
      video_id: videoId,
      language_code: targetLanguage,
      text: translation.text,
      model,
      version: 1,
    }];
  });

  if (rows.length === 0) return;

  await sql`
    insert into translated_segments ${sql(rows)}
    on conflict (segment_id, language_code, version) do update set
      text = excluded.text, model = excluded.model
  `;
}

function translationProgress(position: number, total: number) {
  if (total <= 0) return 25;
  return Math.min(95, 25 + Math.floor((position / total) * 70));
}
