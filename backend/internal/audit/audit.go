// Package audit records security-relevant actions in an append-only table.
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// Actions.
const (
	SignIn        = "auth.signin"
	SignInRefused = "auth.signin_refused"
	SignOut       = "auth.signout"
	PasswordSet   = "auth.password_set"
	UserUpdated   = "user.updated"
	UserDeleted   = "user.deleted"
	InviteCreated = "invite.created"
	InviteDeleted = "invite.deleted"

	AIConnectStarted = "ai.connect_started"
	AIConnected      = "ai.connected"
	AIConnectFailed  = "ai.connect_failed"
	AIDisconnected   = "ai.disconnected"

	DevicePairingCode = "device.pairing_code"
	DevicePaired      = "device.paired"
	DevicePairRefused = "device.pair_refused"
	DeviceRevoked     = "device.revoked"
	SettingsUpdated   = "settings.updated"

	DeviceEngineInstall = "device.engine_install"

	VideoAdded   = "video.added"
	VideoDeleted = "video.deleted"
	JobRequested = "job.requested"
	JobCancelled = "job.cancelled"
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
	// Total is set by ListPage: every matching entry, for page numbers.
	Total int
}

// ListPage returns page number page (from 1) of size entries, newest first,
// with the total number of matching entries. actions, when not empty, keeps
// only those actions.
func (l *Log) ListPage(ctx context.Context, page, size int, actions []string) (Page, error) {
	if size <= 0 || size > 100 {
		size = 15
	}
	if page < 1 {
		page = 1
	}
	where, args := "", []any{}
	if len(actions) > 0 {
		where = "WHERE action IN (" + strings.TrimSuffix(strings.Repeat("?,", len(actions)), ",") + ")"
		for _, action := range actions {
			args = append(args, action)
		}
	}
	var out Page
	if err := l.db.QueryRowContext(ctx, `SELECT count(*) FROM audit_log `+where, args...).Scan(&out.Total); err != nil {
		return Page{}, err
	}
	rows, err := l.db.QueryContext(ctx, `
		SELECT id, at, coalesce(actor_id, ''), actor_email, action, target, detail, ip
		FROM audit_log `+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, append(args, size, (page-1)*size)...)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	out.Entries, err = scanEntries(rows)
	return out, err
}

func scanEntries(rows *sql.Rows) ([]Entry, error) {
	entries := []Entry{}
	for rows.Next() {
		var (
			entry  Entry
			at     string
			detail string
		)
		if err := rows.Scan(&entry.ID, &at, &entry.ActorID, &entry.ActorEmail, &entry.Action, &entry.Target, &detail, &entry.IP); err != nil {
			return nil, err
		}
		entry.At, _ = db.ParseTime(at)
		_ = json.Unmarshal([]byte(detail), &entry.Detail)
		entries = append(entries, entry)
	}
	return entries, rows.Err()
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
