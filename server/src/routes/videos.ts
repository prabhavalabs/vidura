import { Hono } from "hono";
import { sql } from "../db.ts";
import { type AppEnv, requireUser } from "../middleware/auth.ts";
import { parseYouTubeUrl } from "../lib/youtube.ts";
import { enqueueProcessVideo } from "../jobs/boss.ts";
import { fetchTranslationSettings } from "../lib/translation-settings.ts";
import { buildSubtitleResponse } from "../lib/subtitle-response.ts";

export const videos = new Hono<AppEnv>();
videos.use("*", requireUser);

type VideoRow = {
  id: string;
  youtube_video_id: string;
  youtube_url: string;
  title: string;
  channel_title: string | null;
  thumbnail_url: string | null;
  duration_ms: number | null;
  target_language: string;
  status: string;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type JobRow = {
  id: string;
  video_id: string;
  status: string;
  progress: number;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function mapJob(job: JobRow) {
  return {
    id: job.id,
    videoId: job.video_id,
    status: job.status,
    progress: job.progress,
    errorMessage: job.error_message,
    metadata: job.metadata ?? {},
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

function mapVideo(video: VideoRow, latestJob: JobRow | null) {
  const meta = video.metadata ?? {};
  return {
    id: video.id,
    youtubeVideoId: video.youtube_video_id,
    youtubeUrl: video.youtube_url,
    title: video.title,
    channelTitle: video.channel_title,
    thumbnailUrl: video.thumbnail_url ??
      `https://i.ytimg.com/vi/${video.youtube_video_id}/hqdefault.jpg`,
    durationMs: video.duration_ms,
    targetLanguage: video.target_language,
    status: video.status,
    errorMessage: video.error_message,
    // Subtitle provenance + timing-quality score, written by process-video.
    transcriptSource: meta.transcript_source ?? null,
    subtitleQuality: meta.subtitle_quality ?? null,
    translationModel: meta.translation_model ?? null,
    createdAt: video.created_at,
    latestJob: latestJob ? mapJob(latestJob) : null,
  };
}

// GET /api/videos — the library with each video's latest job.
videos.get("/", async (c) => {
  const ownerId = c.get("user").id;
  const videoRows = await sql<VideoRow[]>`
    select id, youtube_video_id, youtube_url, title, channel_title, thumbnail_url,
      duration_ms, target_language, status, error_message, metadata, created_at
    from videos where owner_id = ${ownerId} order by created_at desc
  `;
  if (videoRows.length === 0) return c.json([]);

  const ids = videoRows.map((v) => v.id);
  const jobRows = await sql<JobRow[]>`
    select distinct on (video_id) id, video_id, status, progress, error_message,
      metadata, created_at, updated_at
    from processing_jobs where video_id in ${sql(ids)}
    order by video_id, created_at desc
  `;
  const latestByVideo = new Map(jobRows.map((j) => [j.video_id, j]));

  return c.json(videoRows.map((v) => mapVideo(v, latestByVideo.get(v.id) ?? null)));
});

// GET /api/videos/:id/transcript — source + Sinhala per segment.
videos.get("/:id/transcript", async (c) => {
  const ownerId = c.get("user").id;
  const videoId = c.req.param("id");

  const [video] = await sql<Array<{ id: string; target_language: string }>>`
    select id, target_language from videos where id = ${videoId} and owner_id = ${ownerId}
  `;
  if (!video) return c.json({ error: "Video not found" }, 404);

  const segments = await sql<
    Array<{ id: string; start_ms: number; end_ms: number; text: string }>
  >`
    select id, start_ms, end_ms, text from transcript_segments
    where video_id = ${videoId} order by segment_index asc
  `;
  if (segments.length === 0) return c.json([]);

  const translations = await sql<Array<{ segment_id: string; text: string }>>`
    select segment_id, text from translated_segments
    where video_id = ${videoId} and language_code = ${video.target_language}
  `;
  return c.json(buildSubtitleResponse(segments, translations));
});

// POST /api/videos — create/refresh a video and enqueue processing.
videos.post("/", async (c) => {
  const ownerId = c.get("user").id;
  const body = await c.req.json().catch(() => null) as
    | {
      youtubeUrl?: string;
      title?: string;
      channelTitle?: string;
      thumbnailUrl?: string;
      targetLanguage?: string;
      segments?: Array<{ startMs?: number; endMs?: number; text?: string }>;
    }
    | null;

  const parsed = parseYouTubeUrl(body?.youtubeUrl ?? "");
  if (!parsed) {
    return c.json(
      { error: "Paste a valid YouTube video, Shorts, embed, or youtu.be link." },
      400,
    );
  }

  const targetLanguage = body?.targetLanguage ??
    (await fetchTranslationSettings(ownerId)).targetLanguage;
  const title = body?.title?.trim().slice(0, 180) ||
    `YouTube lesson ${parsed.videoId}`;

  const [video] = await sql<VideoRow[]>`
    insert into videos (owner_id, youtube_video_id, youtube_url, title,
      channel_title, thumbnail_url, target_language, status)
    values (${ownerId}, ${parsed.videoId}, ${parsed.canonicalUrl}, ${title},
      ${body?.channelTitle?.trim() ?? null},
      ${body?.thumbnailUrl?.trim() ??
    `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg`},
      ${targetLanguage}, 'queued')
    on conflict (owner_id, youtube_video_id) do update set
      youtube_url = excluded.youtube_url, status = 'queued', error_message = null
    returning id, youtube_video_id, youtube_url, title, channel_title,
      thumbnail_url, duration_ms, target_language, status, error_message,
      metadata, created_at
  `;
  if (!video) return c.json({ error: "Failed to create video" }, 500);

  const [job] = await sql<JobRow[]>`
    insert into processing_jobs (owner_id, video_id, kind, status, progress, metadata)
    values (${ownerId}, ${video.id}, 'process_video', 'queued', 0,
      ${sql.json({ stage: "queued", requested_language_code: targetLanguage })})
    returning id, video_id, status, progress, error_message, metadata,
      created_at, updated_at
  `;
  if (!job) return c.json({ error: "Failed to create job" }, 500);

  await enqueueProcessVideo({
    jobId: job.id,
    videoId: video.id,
    ownerId,
    sourceLanguage: "en",
    targetLanguage,
    segments: body?.segments ?? [],
    forceRetranslate: false,
    rebuildContext: false,
    forceRefetchTranscript: false,
  });

  return c.json({ video: mapVideo(video, null), job: mapJob(job) }, 201);
});

// POST /api/videos/:id/regenerate — rebuild subtitles or the whole transcript.
videos.post("/:id/regenerate", async (c) => {
  const ownerId = c.get("user").id;
  const videoId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as {
    targetLanguage?: string;
    rebuildContext?: boolean;
    regenerateTranscript?: boolean;
  };

  const [video] = await sql<Array<{ id: string; target_language: string }>>`
    select id, target_language from videos where id = ${videoId} and owner_id = ${ownerId}
  `;
  if (!video) return c.json({ error: "Video not found" }, 404);

  const targetLanguage = body.targetLanguage ?? video.target_language ?? "si-LK";
  const regenerateTranscript = body.regenerateTranscript ?? false;

  if (!regenerateTranscript) {
    const countRows = await sql<Array<{ count: string }>>`
      select count(*)::text as count from transcript_segments where video_id = ${videoId}
    `;
    if (Number(countRows[0]?.count ?? "0") === 0) {
      return c.json(
        { error: "This video has no transcript to regenerate subtitles from." },
        400,
      );
    }
  }

  const [active] = await sql<Array<{ id: string }>>`
    select id from processing_jobs where video_id = ${videoId}
      and status in ('queued', 'running') order by created_at desc limit 1
  `;
  if (active) return c.json({ error: "This video is already being processed." }, 409);

  const [job] = await sql<JobRow[]>`
    insert into processing_jobs (owner_id, video_id, kind, status, progress, metadata)
    values (${ownerId}, ${videoId}, 'translate_segments', 'queued', 0,
      ${sql.json({
    stage: "queued",
    requested_language_code: targetLanguage,
    regenerate: true,
    regenerate_transcript: regenerateTranscript,
  })})
    returning id, video_id, status, progress, error_message, metadata,
      created_at, updated_at
  `;
  if (!job) return c.json({ error: "Failed to create regeneration job" }, 500);

  await sql`
    update videos set status = ${regenerateTranscript ? "fetching_transcript" : "translating"},
      error_message = null where id = ${videoId}
  `;

  await enqueueProcessVideo({
    jobId: job.id,
    videoId,
    ownerId,
    sourceLanguage: "en",
    targetLanguage,
    segments: [],
    forceRetranslate: true,
    rebuildContext: body.rebuildContext ?? true,
    forceRefetchTranscript: regenerateTranscript,
  });

  return c.json({ video: { id: videoId, status: "translating" }, job: mapJob(job) }, 201);
});

// POST /api/videos/:id/resume — re-enqueue a stalled job (frontend safety net).
videos.post("/:id/resume", async (c) => {
  const ownerId = c.get("user").id;
  const videoId = c.req.param("id");

  const [job] = await sql<JobRow[]>`
    select id, video_id, status, progress, error_message, metadata, created_at, updated_at
    from processing_jobs where video_id = ${videoId} and owner_id = ${ownerId}
    order by created_at desc limit 1
  `;
  if (!job) return c.json({ error: "No job to resume" }, 404);

  await enqueueProcessVideo({
    jobId: job.id,
    videoId,
    ownerId,
    sourceLanguage: "en",
    targetLanguage: (job.metadata?.requested_language_code as string) ?? "si-LK",
    segments: [],
    forceRetranslate: false,
    rebuildContext: false,
    forceRefetchTranscript: false,
  });

  return c.json({ ok: true });
});

// DELETE /api/videos/:id
videos.delete("/:id", async (c) => {
  const ownerId = c.get("user").id;
  const videoId = c.req.param("id");
  await sql`delete from videos where id = ${videoId} and owner_id = ${ownerId}`;
  return c.json({ ok: true });
});
