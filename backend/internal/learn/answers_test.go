package learn

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/push"
)

// streamingAI writes answers piece by piece, as its test feeds them.
type streamingAI struct {
	fakeAI
	stream func(ctx context.Context, onDelta func(chatgpt.Delta)) (chatgpt.Result, error)
}

func (f *streamingAI) Stream(ctx context.Context, req chatgpt.Request, onDelta func(chatgpt.Delta)) (chatgpt.Result, error) {
	f.mu.Lock()
	f.requests = append(f.requests, req)
	f.mu.Unlock()
	return f.stream(ctx, onDelta)
}

// fedStream answers with each piece sent on pieces, finishing when it closes.
func fedStream(pieces <-chan string) func(context.Context, func(chatgpt.Delta)) (chatgpt.Result, error) {
	return func(ctx context.Context, onDelta func(chatgpt.Delta)) (chatgpt.Result, error) {
		var all string
		for {
			select {
			case piece, ok := <-pieces:
				if !ok {
					return chatgpt.Result{Text: all}, nil
				}
				all += piece
				onDelta(chatgpt.Delta{Text: piece})
			case <-ctx.Done():
				return chatgpt.Result{}, ctx.Err()
			}
		}
	}
}

type fakeNotifier struct {
	sent chan push.Message
}

func (n *fakeNotifier) Send(_ context.Context, _ string, m push.Message) (int, error) {
	n.sent <- m
	return 1, nil
}

func (n *fakeNotifier) LearnFinished(string, string, string, string, bool) {}

// asyncFixture writes answers in the background, like the server.
func asyncFixture(t *testing.T) (*fixture, *streamingAI, *fakeNotifier) {
	f := newFixture(t)
	ai := &streamingAI{}
	f.svc.ai = ai
	f.svc.background = func(fn func()) { go fn() }
	notifier := &fakeNotifier{sent: make(chan push.Message, 4)}
	f.svc.SetNotifier(notifier)
	return f, ai, notifier
}

type listener struct {
	events chan Event
	err    chan error
}

func follow(ctx context.Context, svc *Service, id string) listener {
	l := listener{events: make(chan Event, 64), err: make(chan error, 1)}
	go func() {
		l.err <- svc.Follow(ctx, "owner", id, func(e Event) error {
			l.events <- e
			return nil
		})
	}()
	return l
}

func (l listener) next(t *testing.T) Event {
	t.Helper()
	select {
	case e := <-l.events:
		return e
	case <-time.After(5 * time.Second):
		t.Fatal("no event")
		return Event{}
	}
}

func waitDone(t *testing.T, svc *Service, id string) {
	t.Helper()
	if a := svc.answering.get(id); a != nil {
		select {
		case <-a.done:
		case <-time.After(5 * time.Second):
			t.Fatal("the answer never finished")
		}
	}
}

func TestAnswersStreamToEveryListenerAndLateOnesCatchUp(t *testing.T) {
	f, ai, notifier := asyncFixture(t)
	ctx := context.Background()
	pieces := make(chan string)
	ai.stream = fedStream(pieces)

	thread, messages, err := f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "සිනැප්සය?", Locale: "si"})
	require.NoError(t, err)
	reply := messages[1]
	assert.Equal(t, StatusStreaming, reply.Status)
	assert.Empty(t, reply.Content)

	first := follow(ctx, f.svc, reply.ID)
	assert.Equal(t, Event{Type: "snapshot"}, first.next(t), "nothing yet: the app shows it's thinking")
	pieces <- "සිනැප්ස"
	assert.Equal(t, Event{Type: "delta", Text: "සිනැප්ස"}, first.next(t))

	late := follow(ctx, f.svc, reply.ID)
	assert.Equal(t, Event{Type: "snapshot", Text: "සිනැප්ස"}, late.next(t), "a late listener starts from the text so far")
	elsewhere, err := f.svc.Messages(ctx, "owner", thread.ID)
	require.NoError(t, err)
	assert.Equal(t, "සිනැප්ස", elsewhere[1].Content, "reopening the conversation shows the text so far")
	assert.Equal(t, StatusStreaming, elsewhere[1].Status)

	_, _, err = f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "Another?", Locale: "en"})
	assert.ErrorIs(t, err, ErrAnswering, "one answer at a time in a conversation")

	pieces <- "ය [0:03]"
	assert.Equal(t, Event{Type: "delta", Text: "ය [0:03]"}, first.next(t))
	assert.Equal(t, Event{Type: "delta", Text: "ය [0:03]"}, late.next(t))
	close(pieces)

	for _, l := range []listener{first, late} {
		end := l.next(t)
		require.Equal(t, "end", end.Type)
		assert.Equal(t, StatusDone, end.Message.Status)
		assert.Equal(t, "සිනැප්සය [0:03]", end.Message.Content)
		require.NoError(t, <-l.err)
	}
	saved, err := f.svc.message(ctx, "owner", reply.ID)
	require.NoError(t, err)
	assert.Equal(t, "සිනැප්සය [0:03]", saved.Content)
	assert.Equal(t, StatusDone, saved.Status)

	select {
	case m := <-notifier.sent:
		t.Fatalf("the learner was watching; no notification expected, got %+v", m)
	case <-time.After(100 * time.Millisecond):
	}

	finished := follow(ctx, f.svc, reply.ID)
	assert.Equal(t, Event{Type: "snapshot", Text: "සිනැප්සය [0:03]"}, finished.next(t), "a finished answer is sent at once")
	assert.Equal(t, StatusDone, finished.next(t).Message.Status)

	_, err = f.svc.Stop(ctx, "other", reply.ID)
	assert.ErrorIs(t, err, ErrNotFound)
	assert.ErrorIs(t, f.svc.Follow(ctx, "other", reply.ID, func(Event) error { return nil }), ErrNotFound, "someone else's answer")
	assert.ErrorIs(t, f.svc.Follow(ctx, "owner", messages[0].ID, func(Event) error { return nil }), ErrNotFound, "a question isn't streamed")
}

func TestAnswersOutliveTheRequestAndNotifyWhenNobodyIsWatching(t *testing.T) {
	f, ai, notifier := asyncFixture(t)
	pieces := make(chan string)
	ai.stream = fedStream(pieces)

	ctx, cancel := context.WithCancel(context.Background())
	thread, messages, err := f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "Why?", Locale: "en"})
	require.NoError(t, err)
	cancel() // the learner left: the request is gone

	pieces <- "Because *neurons* [0:03] fire."
	close(pieces)
	waitDone(t, f.svc, messages[1].ID)

	select {
	case m := <-notifier.sent:
		assert.Equal(t, "How neurons talk", m.Title)
		assert.Equal(t, "Vidura: Because neurons 0:03 fire.", m.Body)
		assert.Equal(t, "/watch/v1?tab=ask", m.URL)
		assert.Equal(t, "chat-"+thread.ID, m.Tag)
		assert.Equal(t, "chat_answer", m.Kind)
	case <-time.After(5 * time.Second):
		t.Fatal("no notification")
	}
	saved, err := f.svc.message(context.Background(), "owner", messages[1].ID)
	require.NoError(t, err)
	assert.Equal(t, StatusDone, saved.Status)
}

func TestStoppingKeepsThePartialAnswerAndRetryWritesItAgain(t *testing.T) {
	f, ai, notifier := asyncFixture(t)
	ctx := context.Background()
	pieces := make(chan string)
	ai.stream = fedStream(pieces)

	thread, messages, err := f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "Why?", Locale: "en"})
	require.NoError(t, err)
	reply := messages[1]
	watching := follow(ctx, f.svc, reply.ID)
	watching.next(t)
	pieces <- "Half an"
	watching.next(t)

	stopped, err := f.svc.Stop(ctx, "owner", reply.ID)
	require.NoError(t, err)
	assert.Equal(t, StatusStopped, stopped.Status)
	assert.Equal(t, "Half an", stopped.Content)
	end := watching.next(t)
	assert.Equal(t, StatusStopped, end.Message.Status, "everyone watching hears it stopped")

	again, err := f.svc.Stop(ctx, "owner", reply.ID)
	require.NoError(t, err, "stopping twice is harmless")
	assert.Equal(t, StatusStopped, again.Status)

	retryPieces := make(chan string)
	ai.stream = fedStream(retryPieces)
	retried, err := f.svc.Retry(ctx, "owner", reply.ID, "en")
	require.NoError(t, err)
	assert.Equal(t, StatusStreaming, retried.Status)
	assert.Empty(t, retried.Content)
	_, err = f.svc.Retry(ctx, "owner", reply.ID, "en")
	assert.ErrorIs(t, err, ErrAnswering, "already being written")
	retryPieces <- "A whole answer."
	close(retryPieces)
	waitDone(t, f.svc, reply.ID)

	history, err := f.svc.Messages(ctx, "owner", thread.ID)
	require.NoError(t, err)
	require.Len(t, history, 2, "the retry replaced the answer")
	assert.Equal(t, "A whole answer.", history[1].Content)
	assert.Equal(t, StatusDone, history[1].Status)
	assert.Contains(t, ai.last().Input, "Why?")
	<-notifier.sent // nobody was watching the retry
}

func TestFailedAnswersSayWhyAndNotify(t *testing.T) {
	f, ai, notifier := asyncFixture(t)
	ctx := context.Background()
	ai.stream = func(_ context.Context, onDelta func(chatgpt.Delta)) (chatgpt.Result, error) {
		onDelta(chatgpt.Delta{Text: "Part"})
		return chatgpt.Result{}, chatgpt.ErrQuota
	}
	_, err := f.db.Exec(`UPDATE users SET locale = 'si' WHERE id = 'owner'`)
	require.NoError(t, err)
	_, messages, err := f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "Why?", Locale: "si"})
	require.NoError(t, err)
	waitDone(t, f.svc, messages[1].ID)
	failed, err := f.svc.message(ctx, "owner", messages[1].ID)
	require.NoError(t, err)
	assert.Equal(t, StatusFailed, failed.Status)
	assert.Equal(t, FailQuota, failed.Error)
	assert.Equal(t, "Part", failed.Content)
	m := <-notifier.sent
	assert.Equal(t, "chat_failed", m.Kind)
	assert.Contains(t, m.Body, "නැවත", "in the learner's language")
}

func TestARestartedServerFailsAnswersInProgress(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.ai.answer = func(chatgpt.Request) (chatgpt.Result, error) { return chatgpt.Result{Text: "Fine."}, nil }
	thread, _, err := f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "Why?", Locale: "en"})
	require.NoError(t, err)
	_, err = f.db.Exec(`UPDATE chat_messages SET status = 'streaming' WHERE role = 'assistant'`)
	require.NoError(t, err)
	f.svc.Recover(ctx)
	messages, err := f.svc.Messages(ctx, "owner", thread.ID)
	require.NoError(t, err)
	assert.Equal(t, StatusFailed, messages[1].Status)
	assert.Equal(t, FailRestarted, messages[1].Error)
}

func TestAttachedVideosAreWhatTheAnswerIsAbout(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.ai.answer = func(chatgpt.Request) (chatgpt.Result, error) { return chatgpt.Result{Text: "See [0:03]."}, nil }

	thread, messages, err := f.svc.Ask(ctx, "owner", Question{Text: "What is a synapse?", Locale: "en", AttachedVideoID: "v1"})
	require.NoError(t, err)
	assert.Nil(t, thread.VideoID, "still a library conversation")
	req := f.ai.last()
	assert.Contains(t, req.Input, "[0:03] A synapse passes the signal on. | සිංහල s2", "the attached video's transcript")
	assert.NotContains(t, req.Input, "The learner's videos", "not the whole library")
	assert.Contains(t, req.System, "[m:ss]")
	require.NotNil(t, messages[0].Video)
	assert.Equal(t, "How neurons talk", messages[0].Video.Title)

	saved, err := f.svc.Messages(ctx, "owner", thread.ID)
	require.NoError(t, err)
	require.NotNil(t, saved[0].Video, "the question remembers its video")
	require.NotNil(t, saved[1].Video, "the answer's times point into it")
	assert.Equal(t, "v1", saved[1].Video.ID)

	_, _, err = f.svc.Ask(ctx, "owner", Question{ThreadID: thread.ID, Text: "And?", Locale: "en", AttachedVideoID: "empty"})
	assert.ErrorIs(t, err, ErrNotReady)
	_, _, err = f.svc.Ask(ctx, "other", Question{Text: "Hm?", Locale: "en", AttachedVideoID: "v1"})
	assert.ErrorIs(t, err, ErrNotFound, "someone else's video")

	// In a video's conversation, an attached video is a second one.
	now := db.FormatTime(time.Now())
	_, err = f.db.Exec(`INSERT INTO videos (id, owner_id, youtube_video_id, youtube_url, title, status, created_at, updated_at)
		VALUES ('v2', 'owner', 'ccccccccccc', 'https://youtu.be/ccccccccccc', 'Brains and computers', 'ready', ?, ?)`, now, now)
	require.NoError(t, err)
	_, err = f.db.Exec(`INSERT INTO transcript_segments (id, video_id, segment_index, start_ms, end_ms, source_language, text, created_at)
		VALUES ('x1', 'v2', 0, 0, 2000, 'en', 'Computers copy neurons.', ?)`, now)
	require.NoError(t, err)
	_, messages, err = f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "How do they compare?", Locale: "en", AttachedVideoID: "v2"})
	require.NoError(t, err)
	req = f.ai.last()
	assert.Contains(t, req.Input, "A synapse passes the signal on.")
	assert.Contains(t, req.Input, "=== Another video the learner attached ===")
	assert.Contains(t, req.Input, "Computers copy neurons.")
	assert.Contains(t, req.System, "without square brackets")
	assert.Equal(t, "v2", messages[0].Video.ID)
	assert.Nil(t, messages[1].Video, "times in a video's conversation seek that video")
}

func TestListenersNeverBlockTheWriter(t *testing.T) {
	f, ai, _ := asyncFixture(t)
	ctx := context.Background()
	pieces := make(chan string)
	ai.stream = fedStream(pieces)
	_, messages, err := f.svc.Ask(ctx, "owner", Question{VideoID: "v1", Text: "Why?", Locale: "en"})
	require.NoError(t, err)

	// A listener that reads nothing for a while.
	var mu sync.Mutex
	var got []Event
	gate := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- f.svc.Follow(ctx, "owner", messages[1].ID, func(e Event) error {
			<-gate
			mu.Lock()
			got = append(got, e)
			mu.Unlock()
			return nil
		})
	}()
	for _, piece := range []string{"a", "b", "c", "d"} {
		pieces <- piece // never waits for the stuck listener
	}
	close(pieces)
	waitDone(t, f.svc, messages[1].ID)
	close(gate)
	require.NoError(t, <-done)

	mu.Lock()
	defer mu.Unlock()
	text := ""
	for _, e := range got {
		switch e.Type {
		case "snapshot":
			text = e.Text
		case "delta":
			text += e.Text
		}
	}
	assert.Equal(t, "abcd", text, "it caught up with everything, however the pieces were grouped")
	assert.Equal(t, "end", got[len(got)-1].Type)
}

func TestSnippet(t *testing.T) {
	assert.Equal(t, "Neurons fire at 3:05 and rest.", snippet("## Neurons\n\n- **fire** at [3:05]\n- and `rest`.", 100))
	assert.Equal(t, "ab…", snippet("abcdef", 3))
}
