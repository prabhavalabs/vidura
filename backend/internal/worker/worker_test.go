package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/catalog"
	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/pipeline"
	"github.com/prabhavalabs/vidura/backend/internal/settings"
)

type fakeCaptions struct {
	segments []pipeline.Segment
	err      error
}

func (f fakeCaptions) FetchCaptions(context.Context, string) (pipeline.Captions, error) {
	meta := pipeline.Metadata{Title: "How Neurons Communicate", ChannelTitle: "BrainFacts", DurationMs: 10_000}
	return pipeline.Captions{Metadata: meta, Segments: f.segments, Track: "en"}, f.err
}

// echoModel translates every requested line as "si:<text>"; block, when
// set, holds each call until it is closed.
type echoModel struct {
	mu    sync.Mutex
	calls int
	block chan struct{}
}

func (m *echoModel) Exec(ctx context.Context, req chatgpt.Request) (chatgpt.Result, error) {
	m.mu.Lock()
	m.calls++
	m.mu.Unlock()
	if m.block != nil {
		select {
		case <-m.block:
		case <-ctx.Done():
			return chatgpt.Result{}, ctx.Err()
		}
	}
	var in struct {
		TranslateIndices []int `json:"translateIndices"`
		Transcript       []struct {
			Index int    `json:"index"`
			Text  string `json:"text"`
		} `json:"transcript"`
	}
	_ = json.Unmarshal([]byte(req.Input), &in)
	if in.TranslateIndices == nil {
		return chatgpt.Result{Text: `{"topic":"Neurons","summary":"Signals","audience":"all","translationGuidelines":"plain","keyTerms":[{"source":"neuron","preferredSinhala":"නියුරෝනය"}]}`}, nil
	}
	text := map[int]string{}
	for _, l := range in.Transcript {
		text[l.Index] = l.Text
	}
	out := []map[string]any{}
	for _, i := range in.TranslateIndices {
		out = append(out, map[string]any{"index": i, "src": text[i], "text": "si:" + text[i]})
	}
	data, _ := json.Marshal(map[string]any{"translations": out})
	return chatgpt.Result{Text: string(data)}, nil
}

var cues = []pipeline.Segment{
	{StartMs: 0, EndMs: 2000, Text: "Neurons talk to each other with electrical signals."},
	{StartMs: 2000, EndMs: 4000, Text: "Each signal crosses a tiny gap called a synapse."},
	{StartMs: 4000, EndMs: 9000, Text: "That is how you think."},
}

func setup(t *testing.T, opts Options) (*sql.DB, *Worker, *catalog.Store) {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })
	now := db.FormatTime(time.Now())
	_, err = database.Exec(`INSERT INTO users (id, email, name, role) VALUES ('u1', 'owner@example.com', 'Owner', 'superuser')`)
	require.NoError(t, err)
	_, err = database.Exec(`INSERT INTO videos (id, owner_id, youtube_video_id, youtube_url, title, status, error_message, created_at, updated_at)
		VALUES ('v1', 'u1', 'hGDvvUNU-cw', 'https://youtu.be/hGDvvUNU-cw', 'YouTube lesson hGDvvUNU-cw', 'failed', 'old error', ?, ?)`, now, now)
	require.NoError(t, err)
	opts.Poll = 20 * time.Millisecond
	return database, New(database, settings.NewStore(database), opts), catalog.NewStore(database)
}

func start(t *testing.T, w *Worker) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); w.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
}

func waitFor(t *testing.T, database *sql.DB, jobID, status string) {
	t.Helper()
	require.Eventually(t, func() bool {
		var got string
		_ = database.QueryRow(`SELECT status FROM jobs WHERE id = ?`, jobID).Scan(&got)
		return got == status
	}, 5*time.Second, 10*time.Millisecond, "job never reached %s", status)
}

func videoState(t *testing.T, database *sql.DB) (status string, message sql.NullString) {
	t.Helper()
	require.NoError(t, database.QueryRow(`SELECT status, error_message FROM videos WHERE id = 'v1'`).Scan(&status, &message))
	return
}

func TestRequestingARunGivesTheVideoOneStatus(t *testing.T) {
	database, _, store := setup(t, Options{})
	_, err := store.RequestJob(context.Background(), "v1", "process_video", "u1")
	require.NoError(t, err)
	status, message := videoState(t, database)
	assert.Equal(t, "queued", status, "the old failure is replaced, not shown beside the new run")
	assert.False(t, message.Valid)
}

func TestProcessesAVideoEndToEnd(t *testing.T) {
	model := &echoModel{}
	database, w, store := setup(t, Options{Model: model, Captions: fakeCaptions{segments: cues}})
	start(t, w)
	job, err := store.RequestJob(context.Background(), "v1", "process_video", "u1")
	require.NoError(t, err)
	w.Notify()
	waitFor(t, database, job.ID, "succeeded")

	status, _ := videoState(t, database)
	assert.Equal(t, "ready", status)
	detail, err := store.GetVideo(context.Background(), "v1")
	require.NoError(t, err)
	assert.Equal(t, "How Neurons Communicate", detail.Video.Title, "title comes from YouTube")
	assert.Equal(t, "captions", *detail.Video.TranscriptSource)
	require.NotEmpty(t, detail.Segments)
	assert.Equal(t, len(detail.Segments), detail.Video.Translated)
	for _, s := range detail.Segments {
		require.NotNil(t, s.Translation)
		assert.Equal(t, "si:"+s.Text, *s.Translation)
	}
	got, err := store.GetJob(context.Background(), job.ID)
	require.NoError(t, err)
	assert.Equal(t, 100, got.Progress)
	assert.NotNil(t, got.DurationMs)

	// Retranslate redoes the translation but keeps the transcript.
	model.calls = 0
	again, err := store.RequestJob(context.Background(), "v1", "retranslate", "u1")
	require.NoError(t, err)
	w.Notify()
	waitFor(t, database, again.ID, "succeeded")
	assert.Equal(t, 2, model.calls, "a fresh glossary and one translation window")
}

func TestNoCaptionsWithoutTranscriberFailsClearly(t *testing.T) {
	database, w, store := setup(t, Options{Model: &echoModel{}, Captions: fakeCaptions{err: pipeline.ErrNoCaptions}})
	start(t, w)
	job, err := store.RequestJob(context.Background(), "v1", "process_video", "u1")
	require.NoError(t, err)
	waitFor(t, database, job.ID, "failed")
	status, message := videoState(t, database)
	assert.Equal(t, "failed", status)
	assert.Contains(t, message.String, "no English captions")
}

type fakeTranscriber struct{}

func (fakeTranscriber) Transcribe(_ context.Context, _, engine string, progress func(int, string)) ([]pipeline.Segment, string, error) {
	progress(50, "Transcribing")
	return cues, engine + " (test)", nil
}

func TestNoCaptionsUsesTheMac(t *testing.T) {
	database, w, store := setup(t, Options{Model: &echoModel{}, Captions: fakeCaptions{err: pipeline.ErrNoCaptions},
		Transcriber: fakeTranscriber{}})
	start(t, w)
	job, err := store.RequestJob(context.Background(), "v1", "process_video", "u1")
	require.NoError(t, err)
	waitFor(t, database, job.ID, "succeeded")
	detail, err := store.GetVideo(context.Background(), "v1")
	require.NoError(t, err)
	assert.Equal(t, "asr", *detail.Video.TranscriptSource)
	assert.Equal(t, "parakeet (test)", *detail.Video.TranscriptEngine)
}

func TestCancelStopsARunningJob(t *testing.T) {
	model := &echoModel{block: make(chan struct{})}
	database, w, store := setup(t, Options{Model: model, Captions: fakeCaptions{segments: cues}})
	start(t, w)
	job, err := store.RequestJob(context.Background(), "v1", "process_video", "u1")
	require.NoError(t, err)
	waitFor(t, database, job.ID, "running")
	require.Eventually(t, func() bool { model.mu.Lock(); defer model.mu.Unlock(); return model.calls > 0 },
		5*time.Second, 10*time.Millisecond)

	_, err = store.CancelJob(context.Background(), job.ID)
	require.NoError(t, err)
	time.Sleep(2500 * time.Millisecond) // the cancel watcher checks every 2 s
	got, err := store.GetJob(context.Background(), job.ID)
	require.NoError(t, err)
	assert.Equal(t, "cancelled", got.Status, "the worker never overwrites a cancel")
	status, message := videoState(t, database)
	assert.Equal(t, "failed", status)
	assert.Equal(t, "Cancelled before it finished", message.String)
}

func TestInterruptedJobsAreRequeued(t *testing.T) {
	database, w, store := setup(t, Options{Model: &echoModel{}, Captions: fakeCaptions{segments: cues}})
	job, err := store.RequestJob(context.Background(), "v1", "process_video", "u1")
	require.NoError(t, err)
	_, err = database.Exec(`UPDATE jobs SET status = 'running' WHERE id = ?`, job.ID)
	require.NoError(t, err)
	start(t, w)
	waitFor(t, database, job.ID, "succeeded")
}

func TestRetranscribeAlwaysUsesTheMac(t *testing.T) {
	database, w, store := setup(t, Options{Model: &echoModel{}, Captions: fakeCaptions{segments: cues},
		Transcriber: fakeTranscriber{}})
	start(t, w)
	job, err := store.RequestJob(context.Background(), "v1", "retranscribe", "u1")
	require.NoError(t, err)
	waitFor(t, database, job.ID, "succeeded")
	detail, err := store.GetVideo(context.Background(), "v1")
	require.NoError(t, err)
	assert.Equal(t, "asr", *detail.Video.TranscriptSource, "captions exist but the Mac was asked")
}
