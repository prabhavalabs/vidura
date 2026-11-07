package catalog

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

func seeded(t *testing.T) *Store {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })
	exec := func(query string, args ...any) {
		_, err := database.Exec(query, args...)
		require.NoError(t, err, query)
	}
	now := "2026-11-01T10:00:00.000Z"
	exec(`INSERT INTO users (id, email, name, role) VALUES ('u1', 'owner@example.com', 'Owner', 'superuser')`)
	exec(`INSERT INTO videos (id, owner_id, youtube_video_id, youtube_url, title, duration_ms, status,
			transcript_source, transcript_engine, subtitle_quality, translation_model, translation_context, created_at, updated_at)
		VALUES ('v1', 'u1', 'aaaaaaaaaaa', 'https://youtu.be/a', 'Ready video', 600000, 'ready',
			'captions', 'yt-dlp', '{"score":95,"label":"excellent"}', 'gpt', '{"topic":"Brains"}', ?, ?)`, now, now)
	exec(`INSERT INTO videos (id, owner_id, youtube_video_id, youtube_url, title, duration_ms, status,
			transcript_source, transcript_engine, error_message, created_at, updated_at)
		VALUES ('v2', 'u1', 'bbbbbbbbbbb', 'https://youtu.be/b', 'Failed video', 120000, 'failed',
			'asr', 'gemini', 'boom', '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z')`)
	exec(`INSERT INTO transcript_segments (id, video_id, segment_index, start_ms, end_ms, source_language, text, created_at)
		VALUES ('s1', 'v1', 0, 0, 1000, 'en', 'Hello', ?), ('s2', 'v1', 1, 1000, 2000, 'en', 'World', ?)`, now, now)
	exec(`INSERT INTO translated_segments (id, segment_id, video_id, language_code, text, model, created_at, updated_at)
		VALUES ('t1', 's1', 'v1', 'si', 'ආයුබෝවන්', 'gpt', ?, ?)`, now, now)
	// v1: a 5-minute success; v2: an earlier success, then a failure.
	exec(`INSERT INTO jobs (id, video_id, kind, status, details, created_at, started_at, finished_at, updated_at) VALUES
		('j1', 'v1', 'process_video', 'succeeded', '{"total_segments":2}', ?, '2026-11-01T10:00:00.000Z', '2026-11-01T10:05:00.000Z', ?),
		('j2', 'v2', 'process_video', 'succeeded', '{}', '2026-11-02T09:00:00.000Z', '2026-11-02T09:00:00.000Z', '2026-11-02T09:01:00.000Z', ?),
		('j3', 'v2', 'retranslate', 'failed', '{}', '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:30.000Z', ?)`,
		now, now, now, now)
	exec(`UPDATE jobs SET error_message = 'Incorrect API key provided' WHERE id = 'j3'`)
	return NewStore(database)
}

func TestListVideosIncludesCountsAndLatestJob(t *testing.T) {
	videos, err := seeded(t).ListVideos(context.Background())
	require.NoError(t, err)
	require.Len(t, videos, 2)

	assert.Equal(t, "v2", videos[0].ID, "newest first")
	assert.Equal(t, "j3", videos[0].LastJob.ID, "latest run")
	assert.Equal(t, int64(30_000), *videos[0].LastJob.DurationMs)
	assert.Equal(t, 2, videos[0].Jobs)

	ready := videos[1]
	assert.Equal(t, 2, ready.Segments)
	assert.Equal(t, 1, ready.Translated)
	assert.Equal(t, 95.0, *ready.QualityScore)
	assert.Equal(t, "Owner", ready.Owner.Name)
}

func TestGetVideoJoinsTranslationsAndJobs(t *testing.T) {
	store := seeded(t)
	detail, err := store.GetVideo(context.Background(), "v1")
	require.NoError(t, err)
	require.Len(t, detail.Segments, 2)
	assert.Equal(t, "ආයුබෝවන්", *detail.Segments[0].Translation)
	assert.Nil(t, detail.Segments[1].Translation, "untranslated lines are kept")
	assert.JSONEq(t, `{"topic":"Brains"}`, string(detail.Video.Context))
	require.Len(t, detail.Jobs, 1)
	assert.JSONEq(t, `{"total_segments":2}`, string(detail.Jobs[0].Details))

	_, err = store.GetVideo(context.Background(), "nope")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestStatsSummarizesRuns(t *testing.T) {
	stats, err := seeded(t).Stats(context.Background())
	require.NoError(t, err)

	assert.Equal(t, 2, stats.Totals.Videos)
	assert.Equal(t, 1, stats.Totals.Ready)
	assert.Equal(t, int64(720_000), stats.Totals.VideoMs)
	assert.Equal(t, 3, stats.Processing.Runs)
	assert.Equal(t, 2, stats.Processing.Succeeded)
	assert.InDelta(t, 2.0/3.0, stats.Processing.SuccessRate, 0.001)
	assert.Equal(t, int64(300_000), stats.Processing.P90Ms)
	// 12 minutes of video processed in 6 minutes of successful runs.
	assert.InDelta(t, 2.0, stats.Processing.SpeedRatio, 0.001)
	assert.Equal(t, []NamedCount{{Name: "AI provider sign-in", Count: 1}}, stats.Failures)
	assert.Len(t, stats.Timeline, 3)
	assert.Len(t, stats.Videos, 2)
	require.Len(t, stats.Sources, 2)
}

func TestListJobsFiltersByStatus(t *testing.T) {
	store := seeded(t)
	failed, err := store.ListJobs(context.Background(), "failed", 10)
	require.NoError(t, err)
	require.Len(t, failed, 1)
	assert.Equal(t, "Failed video", failed[0].Video.Title)

	all, err := store.ListJobs(context.Background(), "", 2)
	require.NoError(t, err)
	assert.Len(t, all, 2, "limit applies")
}

func TestFailureReason(t *testing.T) {
	cases := map[string]string{
		"":                            "Unknown",
		"OpenAI failed with 401":      "AI provider sign-in",
		"429 Too Many Requests":       "AI quota or rate limit",
		"context deadline exceeded":   "Timed out",
		"No captions for this video":  "Transcript unavailable",
		"missing segment indices 4,5": "Incomplete translation",
		"weird":                       "Other",
	}
	for message, want := range cases {
		assert.Equal(t, want, FailureReason(message), message)
	}
}

func TestRequestCancelAndDelete(t *testing.T) {
	store := seeded(t)
	ctx := context.Background()

	_, err := store.RequestJob(ctx, "v2", "explode", "u1")
	assert.ErrorIs(t, err, ErrBadKind)
	_, err = store.RequestJob(ctx, "missing", "process_video", "u1")
	assert.ErrorIs(t, err, ErrNotFound)

	job, err := store.RequestJob(ctx, "v2", "retranslate", "u1")
	require.NoError(t, err)
	assert.Equal(t, "queued", job.Status)
	assert.Equal(t, "Failed video", job.Video.Title)

	open, err := store.RequestJob(ctx, "v2", "process_video", "u1")
	assert.ErrorIs(t, err, ErrJobOpen, "one open run per video")
	assert.Equal(t, job.ID, open.ID)

	cancelled, err := store.CancelJob(ctx, job.ID)
	require.NoError(t, err)
	assert.Equal(t, "cancelled", cancelled.Status)
	_, err = store.CancelJob(ctx, job.ID)
	assert.ErrorIs(t, err, ErrNotCancellable)
	_, err = store.CancelJob(ctx, "nope")
	assert.ErrorIs(t, err, ErrNotFound)

	again, err := store.RequestJob(ctx, "v2", "process_video", "u1")
	require.NoError(t, err, "a new run is allowed once the old one is closed")
	assert.NotEqual(t, job.ID, again.ID)

	title, err := store.DeleteVideo(ctx, "v1")
	require.NoError(t, err)
	assert.Equal(t, "Ready video", title)
	_, err = store.GetVideo(ctx, "v1")
	assert.ErrorIs(t, err, ErrNotFound)
	_, err = store.DeleteVideo(ctx, "v1")
	assert.ErrorIs(t, err, ErrNotFound)
	stats, err := store.Stats(ctx)
	require.NoError(t, err)
	assert.Equal(t, 0, stats.Totals.Segments, "segments went with the video")
}
