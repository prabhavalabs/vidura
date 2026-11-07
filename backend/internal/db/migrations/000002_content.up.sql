-- Videos, transcripts, translations, processing history, and the client
-- app's chat, notes and settings. Shapes follow the v1 Postgres schema so the
-- import is a straight copy; language codes are normalized to BCP-47 ("si").

CREATE TABLE videos (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    youtube_video_id    TEXT NOT NULL,
    youtube_url         TEXT NOT NULL,
    title               TEXT NOT NULL,
    channel_title       TEXT,
    thumbnail_url       TEXT,
    duration_ms         INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    source_language     TEXT,
    target_language     TEXT NOT NULL DEFAULT 'si',
    status              TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'fetching_transcript', 'transcribing', 'translating', 'ready', 'failed')),
    error_message       TEXT,
    -- How the English transcript was obtained: YouTube captions, speech
    -- recognition, or an uploaded file; engine names the tool or model.
    transcript_source   TEXT CHECK (transcript_source IN ('captions', 'asr', 'uploaded')),
    transcript_engine   TEXT,
    subtitle_quality    TEXT CHECK (subtitle_quality IS NULL OR json_valid(subtitle_quality)),
    translation_model   TEXT,
    -- Topic, summary, audience and glossary produced before translating.
    translation_context TEXT CHECK (translation_context IS NULL OR json_valid(translation_context)),
    metadata            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE (owner_id, youtube_video_id)
);
CREATE INDEX videos_status_created_idx ON videos (status, created_at DESC);
CREATE INDEX videos_owner_created_idx ON videos (owner_id, created_at DESC);

CREATE TABLE transcript_segments (
    id              TEXT PRIMARY KEY,
    video_id        TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    segment_index   INTEGER NOT NULL CHECK (segment_index >= 0),
    start_ms        INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms          INTEGER NOT NULL,
    source_language TEXT NOT NULL,
    text            TEXT NOT NULL,
    normalized_text TEXT,
    created_at      TEXT NOT NULL,
    UNIQUE (video_id, segment_index),
    CHECK (end_ms > start_ms)
);
CREATE INDEX transcript_segments_video_time_idx ON transcript_segments (video_id, start_ms);

CREATE TABLE translated_segments (
    id            TEXT PRIMARY KEY,
    segment_id    TEXT NOT NULL REFERENCES transcript_segments (id) ON DELETE CASCADE,
    video_id      TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    language_code TEXT NOT NULL DEFAULT 'si',
    text          TEXT NOT NULL,
    model         TEXT NOT NULL,
    quality_flags TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(quality_flags)),
    -- Set when a superuser corrects the line in the admin portal.
    edited_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (segment_id, language_code)
);
CREATE INDEX translated_segments_video_lang_idx ON translated_segments (video_id, language_code);

-- One row per request to process a video. The durable step queue adds its
-- step and event tables next to this one; imported v1 runs are history only
-- (legacy = 1) and keep their v1 progress details in `details`.
CREATE TABLE jobs (
    id               TEXT PRIMARY KEY,
    video_id         TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('process_video', 'retranslate', 'retranscribe')),
    status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    current_step     TEXT,
    progress         INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    requested_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    error_message    TEXT,
    details          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
    legacy           INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    created_at       TEXT NOT NULL,
    started_at       TEXT,
    finished_at      TEXT,
    updated_at       TEXT NOT NULL
);
CREATE INDEX jobs_video_created_idx ON jobs (video_id, created_at DESC);
CREATE INDEX jobs_status_created_idx ON jobs (status, created_at DESC);
CREATE INDEX jobs_created_idx ON jobs (created_at DESC);

CREATE TABLE chat_threads (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    video_id   TEXT REFERENCES videos (id) ON DELETE CASCADE,
    title      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX chat_threads_owner_created_idx ON chat_threads (owner_id, created_at DESC);

CREATE TABLE chat_messages (
    id                TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
    owner_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role              TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content           TEXT NOT NULL,
    cited_segment_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cited_segment_ids)),
    metadata          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
    created_at        TEXT NOT NULL
);
CREATE INDEX chat_messages_thread_created_idx ON chat_messages (thread_id, created_at);

CREATE TABLE video_notes (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    video_id     TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    timestamp_ms INTEGER NOT NULL DEFAULT 0 CHECK (timestamp_ms >= 0),
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX video_notes_owner_video_idx ON video_notes (owner_id, video_id, timestamp_ms);

CREATE TABLE chat_settings (
    owner_id            TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    response_language   TEXT NOT NULL DEFAULT 'auto' CHECK (response_language IN ('auto', 'si', 'en', 'singlish')),
    answer_style        TEXT NOT NULL DEFAULT 'balanced' CHECK (answer_style IN ('concise', 'balanced', 'detailed')),
    custom_instructions TEXT NOT NULL DEFAULT '',
    memory_depth        TEXT NOT NULL DEFAULT 'medium' CHECK (memory_depth IN ('short', 'medium', 'long')),
    retrieval_depth     TEXT NOT NULL DEFAULT 'standard' CHECK (retrieval_depth IN ('focused', 'standard', 'broad')),
    creativity          TEXT NOT NULL DEFAULT 'balanced' CHECK (creativity IN ('focused', 'balanced', 'creative')),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE translation_settings (
    owner_id        TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    target_language TEXT NOT NULL DEFAULT 'si',
    system_prompt   TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE push_subscriptions (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_owner_idx ON push_subscriptions (owner_id);
