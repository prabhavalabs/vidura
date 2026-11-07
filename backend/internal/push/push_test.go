package push

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

func newDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })
	now := db.FormatTime(time.Now())
	for _, id := range []string{"u1", "u2"} {
		_, err := database.Exec(`INSERT INTO users (id, email, name, role, status, created_at, updated_at)
			VALUES (?, ?, ?, 'member', 'active', ?, ?)`, id, id+"@example.com", id, now, now)
		require.NoError(t, err)
	}
	return database
}

// browserKeys makes a real subscription key pair, as a browser would.
func browserKeys(t *testing.T) (p256dh, auth string) {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	require.NoError(t, err)
	secret := make([]byte, 16)
	_, _ = rand.Read(secret)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(key.PublicKey().Bytes()), enc.EncodeToString(secret)
}

func subscription(endpoint, p256dh, auth string) Subscription {
	var sub Subscription
	sub.Endpoint = endpoint
	sub.Keys.P256dh, sub.Keys.Auth = p256dh, auth
	return sub
}

func TestOnlyBrowserPushServicesAreAccepted(t *testing.T) {
	for _, ok := range []string{
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://updates.push.services.mozilla.com/wpush/v2/abc",
		"https://web.push.apple.com/QGx",
		"https://api.push.apple.com/x",
		"https://wns2-par02p.notify.windows.com/w/?token=x",
	} {
		assert.True(t, validEndpoint(ok), ok)
	}
	for _, bad := range []string{
		"http://fcm.googleapis.com/fcm/send/abc",       // not https
		"https://fcm.googleapis.com.evil.example/send", // lookalike
		"https://evilpush.apple.com.example/x",
		"https://127.0.0.1/admin",
		"https://localhost:8080/x",
		"https://fcm.googleapis.com:8443/x", // odd port
		"https://user@fcm.googleapis.com/x",
		"https://notapple.com/push.apple.com",
		"",
	} {
		assert.False(t, validEndpoint(bad), bad)
	}
}

func TestSubscribeIsPerUserAndValidated(t *testing.T) {
	ctx := context.Background()
	s := New(newDB(t), "https://vidura.example.com")
	p, a := browserKeys(t)
	endpoint := "https://fcm.googleapis.com/fcm/send/device-1"

	assert.ErrorIs(t, s.Subscribe(ctx, "u1", subscription("https://evil.example/hook", p, a)), ErrBadSubscription)
	assert.ErrorIs(t, s.Subscribe(ctx, "u1", subscription(endpoint, "", a)), ErrBadSubscription)

	require.NoError(t, s.Subscribe(ctx, "u1", subscription(endpoint, p, a)))
	on, err := s.Subscribed(ctx, "u1", endpoint)
	require.NoError(t, err)
	assert.True(t, on)

	// Someone else can't unsubscribe it…
	require.NoError(t, s.Unsubscribe(ctx, "u2", endpoint))
	on, _ = s.Subscribed(ctx, "u1", endpoint)
	assert.True(t, on)
	// …but when they sign in on that browser it becomes theirs.
	require.NoError(t, s.Subscribe(ctx, "u2", subscription(endpoint, p, a)))
	on, _ = s.Subscribed(ctx, "u1", endpoint)
	assert.False(t, on)
	on, _ = s.Subscribed(ctx, "u2", endpoint)
	assert.True(t, on)
}

func TestKeysAreCreatedOnceAndKept(t *testing.T) {
	ctx := context.Background()
	database := newDB(t)
	first, err := New(database, "https://vidura.example.com").PublicKey(ctx)
	require.NoError(t, err)
	assert.NotEmpty(t, first)
	again, err := New(database, "https://vidura.example.com").PublicKey(ctx)
	require.NoError(t, err)
	assert.Equal(t, first, again, "a restart keeps the same key, so subscriptions stay valid")
}

func TestSendDeliversAndForgetsGoneBrowsers(t *testing.T) {
	ctx := context.Background()
	database := newDB(t)
	var delivered atomic.Int32
	live := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "aes128gcm", r.Header.Get("Content-Encoding"), "the payload is encrypted")
		assert.Contains(t, r.Header.Get("Authorization"), "vapid t=")
		delivered.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer live.Close()
	gone := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer gone.Close()

	s := New(database, "https://vidura.example.com")
	s.client = live.Client() // trusts both test servers' certificate authority
	s.allowed = func(string) bool { return true }
	p, a := browserKeys(t)
	require.NoError(t, s.Subscribe(ctx, "u1", subscription(live.URL+"/a", p, a)))
	require.NoError(t, s.Subscribe(ctx, "u1", subscription(gone.URL+"/b", p, a)))
	require.NoError(t, s.Subscribe(ctx, "u2", subscription(live.URL+"/c", p, a)))

	sent, err := s.Send(ctx, "u1", Message{Title: "t", Body: "b", URL: "/watch/x", Tag: "video-x"})
	require.NoError(t, err)
	assert.Equal(t, 1, sent)
	assert.Equal(t, int32(1), delivered.Load(), "only u1's browsers get u1's message")

	var left int
	require.NoError(t, database.QueryRow(`SELECT count(*) FROM push_subscriptions WHERE owner_id = 'u1'`).Scan(&left))
	assert.Equal(t, 1, left, "a browser that unsubscribed (410) is forgotten")
}

func TestTopicIsSafe(t *testing.T) {
	assert.Equal(t, "video-abc", topic("video-abc"))
	assert.Equal(t, "videoabc", topic("video:a/b c"))
	assert.Len(t, topic("video-0123456789012345678901234567890123456789"), 32)
}
