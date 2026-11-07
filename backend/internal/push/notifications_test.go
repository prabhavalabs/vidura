package push

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSendRecordsNotificationsWithUnreadCount(t *testing.T) {
	ctx := context.Background()
	s := New(newDB(t), "https://vidura.example.com")

	// No browser is subscribed: the notification is still kept for the app.
	sent, err := s.Send(ctx, "u1", Message{Title: "Video A", Body: "failed", URL: "/watch/a", Tag: "video-a", Kind: "video_failed"})
	require.NoError(t, err)
	assert.Zero(t, sent)
	_, err = s.Send(ctx, "u1", Message{Title: "Chat", Body: "answered", URL: "/ask/t1", Kind: "chat_answer"})
	require.NoError(t, err)
	// Same tag: the "ready" replaces the earlier "failed" for that video.
	_, err = s.Send(ctx, "u1", Message{Title: "Video A", Body: "ready", URL: "/watch/a", Tag: "video-a", Kind: "video_ready"})
	require.NoError(t, err)
	// Ephemeral messages (the test) aren't kept.
	_, err = s.Send(ctx, "u1", Message{Title: "Test", Ephemeral: true})
	require.NoError(t, err)
	// Someone else's don't count.
	_, err = s.Send(ctx, "u2", Message{Title: "Other", URL: "/"})
	require.NoError(t, err)

	list, unread, err := s.Notifications(ctx, "u1", 0)
	require.NoError(t, err)
	assert.Equal(t, 2, unread)
	require.Len(t, list, 2)
	assert.Equal(t, "video_ready", list[0].Kind, "newest first")
	assert.Equal(t, "ready", list[0].Body)
	assert.Equal(t, "/watch/a", list[0].URL)
	assert.Nil(t, list[0].ReadAt)
	assert.Equal(t, "chat_answer", list[1].Kind)

	latest, err := s.Latest(ctx, "u1")
	require.NoError(t, err)
	assert.Equal(t, list[0].ID, latest)

	// u2 can't mark u1's notifications read.
	left, err := s.MarkRead(ctx, "u2", []string{list[0].ID}, false)
	require.NoError(t, err)
	assert.Equal(t, 1, left, "u2's own unread count")
	left, err = s.MarkRead(ctx, "u1", []string{list[0].ID, "nope"}, false)
	require.NoError(t, err)
	assert.Equal(t, 1, left)
	left, err = s.MarkRead(ctx, "u1", nil, true)
	require.NoError(t, err)
	assert.Zero(t, left)
	list, _, _ = s.Notifications(ctx, "u1", 0)
	assert.NotNil(t, list[0].ReadAt)
}

func TestNotificationURLsStayInTheApp(t *testing.T) {
	ctx := context.Background()
	s := New(newDB(t), "https://vidura.example.com")
	for _, url := range []string{"https://evil.example", "//evil.example/x", "javascript:alert(1)", ""} {
		_, err := s.Send(ctx, "u1", Message{Title: "x", URL: url})
		require.NoError(t, err)
	}
	list, _, err := s.Notifications(ctx, "u1", 0)
	require.NoError(t, err)
	for _, n := range list {
		assert.Equal(t, "/", n.URL)
	}
}

func TestHistoryIsBounded(t *testing.T) {
	ctx := context.Background()
	s := New(newDB(t), "https://vidura.example.com")
	for range keepPerUser + 5 {
		_, err := s.Send(ctx, "u1", Message{Title: "x", URL: "/"})
		require.NoError(t, err)
	}
	unread, err := s.Unread(ctx, "u1")
	require.NoError(t, err)
	assert.Equal(t, keepPerUser, unread)
}

func TestAppOnScreenGetsNoPush(t *testing.T) {
	ctx := context.Background()
	var delivered atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		delivered.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := New(newDB(t), "https://vidura.example.com")
	s.client = server.Client()
	s.allowed = func(string) bool { return true }
	clock := time.Now()
	s.now = func() time.Time { return clock }
	p, a := browserKeys(t)
	phone, laptop := server.URL+"/phone", server.URL+"/laptop"
	require.NoError(t, s.Subscribe(ctx, "u1", subscription(phone, p, a)))
	require.NoError(t, s.Subscribe(ctx, "u1", subscription(laptop, p, a)))

	// The laptop has Vidura open: only the phone is pushed to.
	s.SetForeground("u1", laptop, true)
	sent, err := s.Send(ctx, "u1", Message{Title: "t", URL: "/"})
	require.NoError(t, err)
	assert.Equal(t, 1, sent)

	// Presence is per user: u2 saying the phone is on screen changes nothing for u1.
	s.SetForeground("u2", phone, true)
	sent, _ = s.Send(ctx, "u1", Message{Title: "t", URL: "/"})
	assert.Equal(t, 1, sent)

	// The test notification goes everywhere.
	sent, _ = s.Send(ctx, "u1", Message{Title: "t", Force: true, Ephemeral: true})
	assert.Equal(t, 2, sent)

	// Hidden again, or silent for too long: both get pushes.
	s.SetForeground("u1", laptop, false)
	sent, _ = s.Send(ctx, "u1", Message{Title: "t", URL: "/"})
	assert.Equal(t, 2, sent)
	s.SetForeground("u1", laptop, true)
	clock = clock.Add(foregroundTTL + time.Second)
	sent, _ = s.Send(ctx, "u1", Message{Title: "t", URL: "/"})
	assert.Equal(t, 2, sent)
	assert.Equal(t, int32(8), delivered.Load())
}
