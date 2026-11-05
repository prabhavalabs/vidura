// Package audit records security-relevant actions in an append-only table.
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// Actions.
const (
	SignIn        = "auth.signin"
	SignInRefused = "auth.signin_refused"
	SignOut       = "auth.signout"
	UserUpdated   = "user.updated"
	UserDeleted   = "user.deleted"
	InviteCreated = "invite.created"
	InviteDeleted = "invite.deleted"
)

// Entry is one audit record.
type Entry struct {
	ID         int64
	At         time.Time
	ActorID    string
	ActorEmail string
	Action     string
	Target     string
	Detail     map[string]any
	IP         string
}

// Log writes and reads the audit table.
type Log struct {
	db  *sql.DB
	now func() time.Time
}

// New returns a Log.
func New(database *sql.DB) *Log { return &Log{db: database, now: time.Now} }

// Record appends an entry. A failure is logged, never returned: an audit
// write must not turn a successful action into an error for the user.
func (l *Log) Record(ctx context.Context, entry Entry) {
	detail := entry.Detail
	if detail == nil {
		detail = map[string]any{}
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		encoded = []byte("{}")
	}
	var actor any
	if entry.ActorID != "" {
		actor = entry.ActorID
	}
	if _, err := l.db.ExecContext(ctx, `
		INSERT INTO audit_log (at, actor_id, actor_email, action, target, detail, ip)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		db.FormatTime(l.now()), actor, entry.ActorEmail, entry.Action, entry.Target, string(encoded), entry.IP,
	); err != nil {
		slog.Error("audit write failed", "action", entry.Action, "error", err)
	}
}

// Page is one page of entries, newest first.
type Page struct {
	Entries    []Entry
	NextCursor string
}

// List returns up to limit entries older than cursor (an entry id), newest
// first, optionally filtered by action.
func (l *Log) List(ctx context.Context, limit int, cursor, action string) (Page, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	before := int64(1 << 62)
	if cursor != "" {
		if parsed, err := strconv.ParseInt(cursor, 10, 64); err == nil {
			before = parsed
		}
	}
	rows, err := l.db.QueryContext(ctx, `
		SELECT id, at, coalesce(actor_id, ''), actor_email, action, target, detail, ip
		FROM audit_log
		WHERE id < ? AND (? = '' OR action = ?)
		ORDER BY id DESC LIMIT ?`, before, action, action, limit+1)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()

	var page Page
	for rows.Next() {
		var (
			entry  Entry
			at     string
			detail string
		)
		if err := rows.Scan(&entry.ID, &at, &entry.ActorID, &entry.ActorEmail, &entry.Action, &entry.Target, &detail, &entry.IP); err != nil {
			return Page{}, err
		}
		entry.At, _ = db.ParseTime(at)
		_ = json.Unmarshal([]byte(detail), &entry.Detail)
		page.Entries = append(page.Entries, entry)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	if len(page.Entries) > limit {
		page.Entries = page.Entries[:limit]
		page.NextCursor = strconv.FormatInt(page.Entries[limit-1].ID, 10)
	}
	return page, nil
}
