-- Study material made from a video's transcript, in one language: a summary,
-- flashcards or a quiz. One of each kind per video and language.
CREATE TABLE video_insights (
    video_id      TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('summary', 'flashcards', 'quiz')),
    locale        TEXT NOT NULL CHECK (locale IN ('en', 'si')),
    status        TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
    content       TEXT CHECK (content IS NULL OR json_valid(content)),
    error_message TEXT,
    model         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (video_id, kind, locale)
);

-- Pictures that explain an idea from a video. The PNG lives in the data
-- folder (images/<video>/<id>.png); the row remembers what it shows.
CREATE TABLE concept_images (
    id            TEXT PRIMARY KEY,
    video_id      TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    owner_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    concept       TEXT NOT NULL,
    caption       TEXT,
    locale        TEXT NOT NULL CHECK (locale IN ('en', 'si')),
    status        TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
    file          TEXT,
    error_message TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX concept_images_video_idx ON concept_images (video_id, created_at);
