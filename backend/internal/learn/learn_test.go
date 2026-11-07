package learn

import (
	"context"
	"database/sql"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/settings"
)

// fakeAI answers like the model would and remembers what it was asked.
type fakeAI struct {
	mu       sync.Mutex
	requests []chatgpt.Request
	answer   func(req chatgpt.Request) (chatgpt.Result, error)
}

func (f *fakeAI) Exec(_ context.Context, req chatgpt.Request) (chatgpt.Result, error) {
	f.mu.Lock()
	f.requests = append(f.requests, req)
	f.mu.Unlock()
	return f.answer(req)
}

func (f *fakeAI) last() chatgpt.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[len(f.requests)-1]
}

type fixture struct {
	db  *sql.DB
	ai  *fakeAI
	svc *Service
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })
	ai := &fakeAI{answer: func(chatgpt.Request) (chatgpt.Result, error) {
		return chatgpt.Result{Text: `{"cards":[{"front":"Q","back":"A","startMs":3000}]}`}, nil
	}}
	svc := New(database, ai, settings.NewStore(database), filepath.Join(t.TempDir(), "images"))
	svc.background = func(f func()) { f() } // run inline
	now := db.FormatTime(time.Now())
	exec := func(query string, args ...any) {
		_, err := database.Exec(query, args...)
		require.NoError(t, err)
	}
	for _, u := range []string{"owner", "other"} {
		exec(`INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)`,
			u, u+"@example.com", u, now, now)
	}
	exec(`INSERT INTO videos (id, owner_id, youtube_video_id, youtube_url, title, status, created_at, updated_at)
		VALUES ('v1', 'owner', 'aaaaaaaaaaa', 'https://youtu.be/aaaaaaaaaaa', 'How neurons talk', 'ready', ?, ?)`, now, now)
	exec(`INSERT INTO videos (id, owner_id, youtube_video_id, youtube_url, title, status, created_at, updated_at)
		VALUES ('empty', 'owner', 'bbbbbbbbbbb', 'https://youtu.be/bbbbbbbbbbb', 'Still processing', 'queued', ?, ?)`, now, now)
	for i, text := range []string{"Neurons send electrical signals.", "A synapse passes the signal on."} {
		id := []string{"s1", "s2"}[i]
		exec(`INSERT INTO transcript_segments (id, video_id, segment_index, start_ms, end_ms, source_language, text, created_at)
			VALUES (?, 'v1', ?, ?, ?, 'en', ?, ?)`, id, i, i*3000, i*3000+2500, text, now)
		exec(`INSERT INTO translated_segments (id, segment_id, video_id, language_code, text, model, created_at, updated_at)
			VALUES (?, ?, 'v1', 'si', ?, 'test', ?, ?)`, "t"+id, id, "සිංහල "+id, now, now)
	}
	return &fixture{db: database, ai: ai, svc: svc}
}

func TestStudyNotesAreMadeAndKept(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	none, err := f.svc.GetInsight(ctx, "owner", "v1", "flashcards", "si")
	require.NoError(t, err)
	assert.Equal(t, "none", none.Status)

	made, err := f.svc.MakeInsight(ctx, "owner", "v1", "flashcards", "si")
	require.NoError(t, err)
	assert.Equal(t, "ready", made.Status, "made inline in tests")
	assert.JSONEq(t, `{"cards":[{"front":"Q","back":"A","startMs":3000}]}`, string(made.Content))

	req := f.ai.last()
	assert.Equal(t, chatgpt.LaneStudy, req.Lane, "study notes don't wait behind translations")
	assert.NotNil(t, req.Schema)
	assert.Contains(t, req.System, "Sinhala", "Sinhala was asked for")
	assert.Contains(t, req.Input, "[0:03] A synapse passes the signal on.")

	english, _ := f.svc.GetInsight(ctx, "owner", "v1", "flashcards", "en")
	assert.Equal(t, "none", english.Status, "each language is separate")
}

func TestStudyNotesRefuseOthersAndBadInput(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, err := f.svc.MakeInsight(ctx, "other", "v1", "summary", "en")
	assert.ErrorIs(t, err, ErrNotFound, "someone else's video")
	_, err = f.svc.MakeInsight(ctx, "owner", "v1", "poem", "en")
	assert.ErrorIs(t, err, ErrBadKind)
	_, err = f.svc.MakeInsight(ctx, "owner", "v1", "summary", "fr")
	assert.ErrorIs(t, err, ErrBadLocale)
	_, err = f.svc.MakeInsight(ctx, "owner", "empty", "summary", "en")
	assert.ErrorIs(t, err, ErrNotReady, "no transcript yet")
}

func TestFailedStudyNotesSayWhy(t *testing.T) {
	f := newFixture(t)
	f.ai.answer = func(chatgpt.Request) (chatgpt.Result, error) { return chatgpt.Result{}, chatgpt.ErrQuota }
	_, err := f.svc.MakeInsight(context.Background(), "owner", "v1", "quiz", "en")
	require.NoError(t, err)
	in, _ := f.svc.GetInsight(context.Background(), "owner", "v1", "quiz", "en")
	assert.Equal(t, "failed", in.Status)
	assert.Equal(t, chatgpt.ErrQuota.Error(), in.Error)
}

func TestVideoChatKeepsOneConversation(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.ai.answer = func(chatgpt.Request) (chatgpt.Result, error) {
		return chatgpt.Result{Text: "සිනැප්සය [0:03] සංඥාව යවයි."}, nil
	}
	thread, messages, err := f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "සිනැප්සය යනු කුමක්ද?", Locale: "si", Voice: true})
	require.NoError(t, err)
	require.Len(t, messages, 2)
	assert.Equal(t, "user", messages[0].Role)
	assert.True(t, messages[0].Voice)
	assert.Equal(t, "assistant", messages[1].Role)
	require.NotNil(t, thread.VideoID)

	req := f.ai.last()
	assert.Contains(t, req.Input, "සිංහල s2", "the tutor sees the Sinhala subtitles too")
	assert.Contains(t, req.System, "[m:ss]")

	again, _, err := f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "And neurons?", Locale: "en"})
	require.NoError(t, err)
	assert.Equal(t, thread.ID, again.ID, "one conversation per video")
	assert.Contains(t, f.ai.last().Input, "සිනැප්සය යනු කුමක්ද?", "earlier turns are remembered")

	history, err := f.svc.Messages(ctx, "owner", thread.ID)
	require.NoError(t, err)
	assert.Len(t, history, 4)
	_, err = f.svc.Messages(ctx, "other", thread.ID)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestLibraryChatFindsMatchingLines(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.ai.answer = func(chatgpt.Request) (chatgpt.Result, error) {
		return chatgpt.Result{Text: "From How neurons talk…"}, nil
	}
	thread, _, err := f.svc.Ask(ctx, "owner", Question{Text: "What did I learn about synapses?", Locale: "en"})
	require.NoError(t, err)
	assert.Nil(t, thread.VideoID)
	assert.Equal(t, "What did I learn about synapses?", thread.Title)
	input := f.ai.last().Input
	assert.Contains(t, input, "- How neurons talk")
	assert.Contains(t, input, "[0:03] A synapse passes the signal on.", "keyword search found the line")

	threads, err := f.svc.LibraryThreads(ctx, "owner")
	require.NoError(t, err)
	assert.Len(t, threads, 1)
	others, _ := f.svc.LibraryThreads(ctx, "other")
	assert.Empty(t, others)

	_, _, err = f.svc.Ask(ctx, "other", Question{ThreadID: thread.ID, Text: "hi there", Locale: "en"})
	assert.ErrorIs(t, err, ErrNotFound, "someone else's conversation")
	require.NoError(t, f.svc.DeleteThread(ctx, "owner", thread.ID))
}

func TestFailedAnswersAreKeptAndCanBeRetried(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.ai.answer = func(chatgpt.Request) (chatgpt.Result, error) { return chatgpt.Result{}, chatgpt.ErrQuota }
	thread, _, err := f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "Why?", Locale: "en"})
	require.NoError(t, err, "the answer is written in the background; its failure is on the answer")
	messages, err := f.svc.Messages(ctx, "owner", thread.ID)
	require.NoError(t, err)
	require.Len(t, messages, 2)
	assert.Equal(t, StatusFailed, messages[1].Status)
	assert.Equal(t, FailQuota, messages[1].Error)

	f.ai.answer = func(chatgpt.Request) (chatgpt.Result, error) { return chatgpt.Result{Text: "Because [0:03]."}, nil }
	_, _, err = f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "And how?", Locale: "en"})
	require.NoError(t, err)
	assert.NotContains(t, f.ai.last().Input, "Why?", "an unanswered question isn't part of the conversation")

	_, err = f.svc.Retry(ctx, "owner", messages[1].ID, "en")
	assert.ErrorIs(t, err, ErrAnswering, "only the latest answer can be retried")
}

func TestPicturesAreDrawnSignedAndCleanedUp(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	generated := filepath.Join(t.TempDir(), "generated_images", "thread")
	require.NoError(t, os.MkdirAll(generated, 0o700))
	png := filepath.Join(generated, "img.png")
	require.NoError(t, os.WriteFile(png, []byte("\x89PNG fake"), 0o600))
	f.ai.answer = func(req chatgpt.Request) (chatgpt.Result, error) {
		return chatgpt.Result{Text: "Two neurons and a synapse.", Images: []string{png}}, nil
	}

	picture, err := f.svc.Illustrate(ctx, "owner", "v1", "How a synapse works", "en")
	require.NoError(t, err)
	req := f.ai.last()
	assert.True(t, req.Images, "only picture runs may use the image tool")
	assert.Contains(t, req.Input, "How a synapse works")

	sign := Signer{Secret: []byte(strings.Repeat("k", 32)), Base: "https://api.example"}
	pictures, err := f.svc.Pictures(ctx, "owner", "v1", sign)
	require.NoError(t, err)
	require.Len(t, pictures, 1)
	assert.Equal(t, "ready", pictures[0].Status)
	assert.Equal(t, "Two neurons and a synapse.", pictures[0].Caption)
	assert.True(t, strings.HasPrefix(pictures[0].URL, "https://api.example/media/images/"+picture.ID+"?e="))
	_, err = os.Stat(generated)
	assert.True(t, os.IsNotExist(err), "the CLI's copy is removed")

	path, err := f.svc.PictureFile(ctx, picture.ID)
	require.NoError(t, err)
	data, _ := os.ReadFile(path)
	assert.Equal(t, "\x89PNG fake", string(data))

	_, err = f.svc.Pictures(ctx, "other", "v1", sign)
	assert.ErrorIs(t, err, ErrNotFound)
	assert.ErrorIs(t, f.svc.DeletePicture(ctx, "other", picture.ID), ErrNotFound)
	require.NoError(t, f.svc.DeletePicture(ctx, "owner", picture.ID))
	_, err = os.Stat(path)
	assert.True(t, os.IsNotExist(err))
}

func TestSignedAddresses(t *testing.T) {
	now := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	sign := Signer{Secret: []byte("secret-secret-secret-secret-1234"), Base: "https://api", now: func() time.Time { return now }}
	url := sign.URL("pic")
	query := url[strings.Index(url, "?")+1:]
	var e, s string
	for _, part := range strings.Split(query, "&") {
		key, value, _ := strings.Cut(part, "=")
		if key == "e" {
			e = value
		} else {
			s = value
		}
	}
	assert.True(t, sign.Valid("pic", e, s))
	assert.False(t, sign.Valid("other", e, s), "signed for one picture only")
	assert.False(t, sign.Valid("pic", e, s[:len(s)-1]+"0"), "tampered")
	later := sign
	later.now = func() time.Time { return now.Add(2 * time.Hour) }
	assert.False(t, later.Valid("pic", e, s), "expired")
}

func TestRecoverFailsLostWork(t *testing.T) {
	f := newFixture(t)
	old := db.FormatTime(time.Now().Add(-time.Hour))
	_, err := f.db.Exec(`INSERT INTO video_insights (video_id, kind, locale, status, created_at, updated_at)
		VALUES ('v1', 'summary', 'en', 'pending', ?, ?)`, old, old)
	require.NoError(t, err)
	f.svc.Recover(context.Background())
	in, _ := f.svc.GetInsight(context.Background(), "owner", "v1", "summary", "en")
	assert.Equal(t, "failed", in.Status)
}

func TestKeywords(t *testing.T) {
	assert.Equal(t, []string{"learn", "synaps"}, keywords("What did I learn about synapses?"), "matches synapse(s)")
	assert.Equal(t, []string{"neuron", "fir"}, keywords("Neurons firing"), "matches fire, fired, firing")
	assert.Equal(t, []string{"සිනැප්සය", "කුමක්ද"}, keywords("සිනැප්සය යනු කුමක්ද?"), "Sinhala words keep their vowel signs")
}

func TestPicturesAreStoredAsJPEG(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "in.png")
	img := image.NewRGBA(image.Rect(0, 0, 64, 32))
	for x := 0; x < 64; x++ {
		img.Set(x, 10, color.RGBA{R: 200, A: 255})
	}
	out, err := os.Create(source)
	require.NoError(t, err)
	require.NoError(t, png.Encode(out, img))
	require.NoError(t, out.Close())

	videoDir := filepath.Join(dir, "video-1")
	require.NoError(t, os.MkdirAll(videoDir, 0o700))
	file, err := savePicture(source, videoDir, "pic")
	require.NoError(t, err)
	assert.Equal(t, filepath.Join("video-1", "pic.jpg"), file)
	data, err := os.ReadFile(filepath.Join(dir, file))
	require.NoError(t, err)
	assert.Equal(t, []byte{0xFF, 0xD8}, data[:2], "a JPEG")
	_, err = os.Stat(source)
	assert.True(t, os.IsNotExist(err), "the PNG is gone")
}
