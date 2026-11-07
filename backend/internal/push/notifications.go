package push

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// Notification is one stored notification, as the app lists it.
type Notification struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	Body      string  `json:"body"`
	URL       string  `json:"url"`
	CreatedAt string  `json:"createdAt"`
	ReadAt    *string `json:"readAt"`
}

// keepPerUser bounds the stored history. Older notifications are deleted as
// new ones arrive; nobody scrolls back past a hundred.
const keepPerUser = 100

// ListLimit is how many notifications the app's list shows.
const ListLimit = 30

// record stores m for ownerID and returns its ID. An unread notification
// with the same tag is replaced, so "subtitles failed" followed by "ready"
// for the same video leaves one item.
func (s *Service) record(ctx context.Context, ownerID string, m Message) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if m.Tag != "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM notifications WHERE owner_id = ? AND tag = ?`,
			ownerID, m.Tag); err != nil {
			return "", err
		}
	}
	id := uuid.NewString()
	url := m.URL
	if !strings.HasPrefix(url, "/") || strings.HasPrefix(url, "//") {
		url = "/"
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO notifications (id, owner_id, kind, title, body, url, tag, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, ownerID, m.Kind, m.Title, m.Body, url, m.Tag, db.FormatTime(s.now())); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM notifications WHERE owner_id = ? AND id NOT IN
		(SELECT id FROM notifications WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
		ownerID, ownerID, keepPerUser); err != nil {
		return "", err
	}
	return id, tx.Commit()
}

// Unread counts ownerID's unread notifications.
func (s *Service) Unread(ctx context.Context, ownerID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM notifications WHERE owner_id = ? AND read_at IS NULL`,
		ownerID).Scan(&n)
	return n, err
}

// Notifications returns ownerID's newest notifications, newest first, and
// how many are unread.
func (s *Service) Notifications(ctx context.Context, ownerID string, limit int) ([]Notification, int, error) {
	if limit <= 0 || limit > keepPerUser {
		limit = ListLimit
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, kind, title, body, url, created_at, read_at FROM notifications
		WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, ownerID, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	list := []Notification{}
	for rows.Next() {
		var n Notification
		var read sql.NullString
		if err := rows.Scan(&n.ID, &n.Kind, &n.Title, &n.Body, &n.URL, &n.CreatedAt, &read); err != nil {
			return nil, 0, err
		}
		if read.Valid {
			n.ReadAt = &read.String
		}
		list = append(list, n)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	unread, err := s.Unread(ctx, ownerID)
	return list, unread, err
}

// Latest returns the ID of ownerID's newest notification ("" when none), so
// an open app can tell that something new arrived without fetching the list.
func (s *Service) Latest(ctx context.Context, ownerID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM notifications WHERE owner_id = ?
		ORDER BY created_at DESC, rowid DESC LIMIT 1`, ownerID).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return id, err
}

// MarkRead marks some of ownerID's notifications read (all of them when all
// is set) and returns how many stay unread. Unknown or foreign IDs are
// ignored.
func (s *Service) MarkRead(ctx context.Context, ownerID string, ids []string, all bool) (int, error) {
	now := db.FormatTime(s.now())
	switch {
	case all:
		if _, err := s.db.ExecContext(ctx, `UPDATE notifications SET read_at = ? WHERE owner_id = ? AND read_at IS NULL`,
			now, ownerID); err != nil {
			return 0, err
		}
	case len(ids) > 0:
		if len(ids) > keepPerUser {
			ids = ids[:keepPerUser]
		}
		args := []any{now, ownerID}
		for _, id := range ids {
			args = append(args, id)
		}
		marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
		if _, err := s.db.ExecContext(ctx, `UPDATE notifications SET read_at = ? WHERE owner_id = ? AND read_at IS NULL
			AND id IN (`+marks+`)`, args...); err != nil {
			return 0, err
		}
	}
	return s.Unread(ctx, ownerID)
}

// --- which apps are on screen ---------------------------------------------

// foregroundTTL is how long an app's "I'm on screen" lasts without being
// renewed. The app renews it every 20 seconds while visible and drops it
// when hidden, so a closed or crashed app stops suppressing pushes quickly.
const foregroundTTL = 50 * time.Second

func presenceKey(ownerID, endpoint string) string { return ownerID + "\x00" + endpoint }

// SetForeground records whether the app using this push endpoint is on
// screen. While it is, Send skips that endpoint: the open app shows the
// notification itself (a toast and the bell), so no system notification
// interrupts someone already looking at Vidura. Skipping the push entirely,
// rather than pushing and staying quiet, matters on iPhone: Safari revokes
// a subscription whose pushes don't show a notification.
func (s *Service) SetForeground(ownerID, endpoint string, visible bool) {
	if endpoint == "" {
		return
	}
	s.presenceMu.Lock()
	defer s.presenceMu.Unlock()
	key := presenceKey(ownerID, endpoint)
	now := s.now()
	if visible {
		s.presence[key] = now.Add(foregroundTTL)
	} else {
		delete(s.presence, key)
	}
	// Drop expired entries so the map can't grow without bound.
	for k, until := range s.presence {
		if now.After(until) {
			delete(s.presence, k)
		}
	}
}

func (s *Service) inForeground(ownerID, endpoint string) bool {
	s.presenceMu.Lock()
	defer s.presenceMu.Unlock()
	until, ok := s.presence[presenceKey(ownerID, endpoint)]
	return ok && s.now().Before(until)
}
