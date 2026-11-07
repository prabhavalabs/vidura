// Package push sends Web Push notifications to the client portal's users.
//
// The server signs every message with its own VAPID key pair, created on
// first use and kept in app_settings (never shown to the admin portal). It
// only ever sends to the browsers' own push services, so a subscription
// can't make the server call an arbitrary address.
package push

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

const vapidKey = "push.vapid"

// ErrBadSubscription is returned for a subscription that isn't from a
// browser push service.
var ErrBadSubscription = errors.New("that isn't a browser push subscription")

// pushHosts are the push services of Chrome/Edge/Android, Firefox, Safari
// and Windows. A subscription must point at one of them.
var pushHosts = []string{
	"fcm.googleapis.com", "android.googleapis.com",
	".push.services.mozilla.com", "push.services.mozilla.com",
	".push.apple.com", "web.push.apple.com",
	".notify.windows.com",
}

// Message is one notification.
type Message struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	// URL is the client portal path opened when the notification is tapped.
	URL string `json:"url"`
	// Tag replaces an earlier notification with the same tag.
	Tag string `json:"tag,omitempty"`
	// Kind says what happened (video_ready, video_failed, chat_answer,
	// chat_failed, notes_ready, ...); the app picks an icon from it.
	Kind string `json:"kind,omitempty"`
	// Ephemeral messages (the settings page's test) are pushed but not kept
	// in the notification list.
	Ephemeral bool `json:"-"`
	// Force pushes even to an app that's on screen, and tells its service
	// worker to show the notification anyway (the settings page's test,
	// which someone presses precisely to see one).
	Force bool `json:"force,omitempty"`

	// Set by Send: the stored notification's ID and the owner's unread
	// count after it, which the service worker shows on the app icon.
	ID     string `json:"id,omitempty"`
	Unread int    `json:"unread"`
}

// Subscription is what the browser's PushManager.subscribe() returns.
type Subscription struct {
	Endpoint string `json:"endpoint"`
	// ExpirationTime is part of PushSubscription.toJSON(); browsers send it
	// (usually null). It's accepted so the strict decoder doesn't refuse the
	// body, and otherwise ignored.
	ExpirationTime *int64 `json:"expirationTime,omitempty"`
	Keys           struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// Service stores subscriptions and sends notifications.
type Service struct {
	db      *sql.DB
	subject string // contact for the push services (the client portal URL)
	client  *http.Client

	allowed     func(endpoint string) bool // validEndpoint; tests swap it
	mu          sync.Mutex                 // guards the keys while they're first loaded
	public      string
	private     string
	sendTimeout time.Duration
	now         func() time.Time

	presenceMu sync.Mutex
	// presence maps owner+endpoint to when its "app on screen" expires.
	presence map[string]time.Time
}

// New returns a Service. subject is a URL or mailto: the push services can
// use to reach the sender.
func New(database *sql.DB, subject string) *Service {
	return &Service{
		db: database, subject: subject,
		client:      &http.Client{Timeout: 15 * time.Second},
		sendTimeout: 15 * time.Second,
		allowed:     validEndpoint,
		now:         time.Now,
		presence:    map[string]time.Time{},
	}
}

// PublicKey returns the VAPID public key browsers subscribe with.
func (s *Service) PublicKey(ctx context.Context) (string, error) {
	if err := s.keys(ctx); err != nil {
		return "", err
	}
	return s.public, nil
}

func (s *Service) keys(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.public != "" {
		return nil
	}
	pair, err := s.loadKeys(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		private, public, genErr := webpush.GenerateVAPIDKeys()
		if genErr != nil {
			return genErr
		}
		encoded, _ := json.Marshal(vapidPair{Public: public, Private: private})
		// Another process may have created keys meanwhile: keep theirs.
		if _, err := s.db.ExecContext(ctx, `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (key) DO NOTHING`, vapidKey, string(encoded), db.FormatTime(time.Now())); err != nil {
			return err
		}
		pair, err = s.loadKeys(ctx)
	}
	if err != nil {
		return err
	}
	s.public, s.private = pair.Public, pair.Private
	return nil
}

type vapidPair struct{ Public, Private string }

func (s *Service) loadKeys(ctx context.Context) (vapidPair, error) {
	var raw string
	if err := s.db.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = ?`, vapidKey).Scan(&raw); err != nil {
		return vapidPair{}, err
	}
	var pair vapidPair
	if err := json.Unmarshal([]byte(raw), &pair); err != nil || pair.Public == "" || pair.Private == "" {
		return vapidPair{}, fmt.Errorf("push: stored VAPID keys are unreadable")
	}
	return pair, nil
}

// validEndpoint accepts only https URLs on a browser push service.
func validEndpoint(raw string) bool {
	if len(raw) > 1024 {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, allowed := range pushHosts {
		if strings.HasPrefix(allowed, ".") {
			if strings.HasSuffix(host, allowed) {
				return true
			}
		} else if host == allowed {
			return true
		}
	}
	return false
}

// Subscribe saves a browser's subscription for ownerID. A browser that
// subscribed before (perhaps as someone else) now belongs to ownerID.
func (s *Service) Subscribe(ctx context.Context, ownerID string, sub Subscription) error {
	if !s.allowed(sub.Endpoint) || sub.Keys.P256dh == "" || sub.Keys.Auth == "" ||
		len(sub.Keys.P256dh) > 200 || len(sub.Keys.Auth) > 100 {
		return ErrBadSubscription
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth, created_at)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET owner_id = excluded.owner_id,
		p256dh = excluded.p256dh, auth = excluded.auth`,
		uuid.NewString(), ownerID, sub.Endpoint, sub.Keys.P256dh, sub.Keys.Auth, db.FormatTime(time.Now()))
	return err
}

// Unsubscribe removes one of ownerID's subscriptions.
func (s *Service) Unsubscribe(ctx context.Context, ownerID, endpoint string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE owner_id = ? AND endpoint = ?`, ownerID, endpoint)
	return err
}

// Subscribed reports whether this endpoint is subscribed for ownerID.
func (s *Service) Subscribed(ctx context.Context, ownerID, endpoint string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM push_subscriptions WHERE owner_id = ? AND endpoint = ?`,
		ownerID, endpoint).Scan(&n)
	return n > 0, err
}

// Send records a notification for ownerID (unless it's Ephemeral) and
// pushes it to every browser ownerID subscribed, except those whose app is
// on screen right now (see SetForeground). Browsers that unsubscribed
// (404/410) are forgotten. It returns how many push services accepted it.
func (s *Service) Send(ctx context.Context, ownerID string, m Message) (int, error) {
	if !m.Ephemeral {
		id, err := s.record(ctx, ownerID, m)
		if err != nil {
			return 0, err
		}
		m.ID = id
	}
	unread, err := s.Unread(ctx, ownerID)
	if err != nil {
		return 0, err
	}
	m.Unread = unread
	if err := s.keys(ctx); err != nil {
		return 0, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE owner_id = ?`, ownerID)
	if err != nil {
		return 0, err
	}
	var subs []webpush.Subscription
	for rows.Next() {
		var sub webpush.Subscription
		if err := rows.Scan(&sub.Endpoint, &sub.Keys.P256dh, &sub.Keys.Auth); err != nil {
			rows.Close()
			return 0, err
		}
		subs = append(subs, sub)
	}
	rows.Close()
	payload, _ := json.Marshal(m)
	sent := 0
	for _, sub := range subs {
		if !s.allowed(sub.Endpoint) || (!m.Force && s.inForeground(ownerID, sub.Endpoint)) {
			continue
		}
		sendCtx, cancel := context.WithTimeout(ctx, s.sendTimeout)
		resp, err := webpush.SendNotificationWithContext(sendCtx, payload, &sub, &webpush.Options{
			HTTPClient:      s.client,
			Subscriber:      s.subject,
			VAPIDPublicKey:  s.public,
			VAPIDPrivateKey: s.private,
			TTL:             int((24 * time.Hour).Seconds()),
			Topic:           topic(m.Tag),
			Urgency:         webpush.UrgencyNormal,
		})
		cancel()
		if err != nil {
			slog.Warn("push: send failed", "host", hostOf(sub.Endpoint), "err", err)
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
			_, _ = s.db.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE endpoint = ?`, sub.Endpoint)
		case resp.StatusCode >= 200 && resp.StatusCode < 300:
			sent++
		default:
			slog.Warn("push: refused", "host", hostOf(sub.Endpoint), "status", resp.StatusCode)
		}
	}
	return sent, nil
}

// topic turns a tag into a push Topic header (at most 32 URL-safe chars).
func topic(tag string) string {
	var b strings.Builder
	for _, r := range tag {
		if b.Len() == 32 {
			break
		}
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func hostOf(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "?"
	}
	return u.Hostname()
}

// VideoFinished tells a video's owner that its run ended. It is called by
// the worker after a run succeeds or fails, and never returns an error: a
// notification that can't be sent is only logged.
func (s *Service) VideoFinished(videoID string, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var owner, title, locale string
	err := s.db.QueryRowContext(ctx, `SELECT v.owner_id, v.title, coalesce(u.locale, 'en') FROM videos v
		JOIN users u ON u.id = v.owner_id WHERE v.id = ?`, videoID).Scan(&owner, &title, &locale)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			slog.Warn("push: look up video", "video", videoID, "err", err)
		}
		return
	}
	m := Message{Title: title, URL: "/watch/" + videoID, Tag: "video-" + videoID, Kind: "video_ready"}
	if !ok {
		m.Kind = "video_failed"
	}
	switch {
	case ok && locale == "si":
		m.Body = "සිංහල උපසිරැසි සූදානම්. දැන් නරඹන්න."
	case ok:
		m.Body = "Sinhala subtitles are ready. Tap to watch."
	case locale == "si":
		m.Body = "උපසිරැසි සෑදීමට නොහැකි විය. නැවත උත්සාහ කිරීමට තට්ටු කරන්න."
	default:
		m.Body = "The subtitles couldn’t be made. Tap to try again."
	}
	if _, err := s.Send(ctx, owner, m); err != nil {
		slog.Warn("push: notify", "video", videoID, "err", fmt.Sprint(err))
	}
}

// LearnFinished tells a person that study material they asked for is ready
// (or couldn't be made). what is "summary", "flashcards", "quiz" or
// "picture". Like VideoFinished it only logs failures.
func (s *Service) LearnFinished(ownerID, videoID, videoTitle, what string, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var locale string
	if err := s.db.QueryRowContext(ctx, `SELECT coalesce(locale, 'en') FROM users WHERE id = ?`, ownerID).Scan(&locale); err != nil {
		slog.Warn("push: look up user", "err", err)
		return
	}
	m := Message{Title: videoTitle, URL: "/watch/" + videoID + "?tab=learn", Tag: what + "-" + videoID}
	kind := "notes"
	if what == "picture" {
		kind = "picture"
		// Every picture is its own notification; they don't replace each other.
		m.Tag = ""
	}
	if ok {
		m.Kind = kind + "_ready"
	} else {
		m.Kind = kind + "_failed"
	}
	m.Body = learnBody(what, ok, locale == "si")
	if _, err := s.Send(ctx, ownerID, m); err != nil {
		slog.Warn("push: notify", "video", videoID, "what", what, "err", fmt.Sprint(err))
	}
}

func learnBody(what string, ok, sinhala bool) string {
	type pair struct{ en, si string }
	names := map[string]pair{
		"summary":    {"summary", "සාරාංශය"},
		"flashcards": {"flashcards", "මතක කාඩ්පත්"},
		"quiz":       {"quiz", "ප්‍රශ්නාවලිය"},
		"picture":    {"picture", "පින්තූරය"},
	}
	name, known := names[what]
	if !known {
		name = pair{"study notes", "අධ්‍යයන සටහන්"}
	}
	switch {
	case ok && sinhala:
		return "ඔබේ " + name.si + " සූදානම්. බැලීමට තට්ටු කරන්න."
	case ok && what == "flashcards":
		return "Your flashcards are ready. Tap to open them."
	case ok:
		return "Your " + name.en + " is ready. Tap to open it."
	case sinhala:
		return "ඔබේ " + name.si + " සෑදීමට නොහැකි විය. නැවත උත්සාහ කිරීමට තට්ටු කරන්න."
	default:
		return "Your " + name.en + " couldn’t be made. Tap to try again."
	}
}
