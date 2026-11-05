// Package accounts owns users, invites (the sign-in allowlist) and sessions,
// and the rules for who may sign in and who may change whom.
package accounts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// Roles and statuses.
const (
	RoleSuperuser = "superuser"
	RoleMember    = "member"

	StatusActive   = "active"
	StatusDisabled = "disabled"
)

// Session lifetime: 30 days, extended (at most once a day) while in use.
const (
	SessionTTL         = 30 * 24 * time.Hour
	sessionRefreshStep = 24 * time.Hour
)

// Errors returned by the store.
var (
	ErrNotAllowed      = errors.New("this Google account hasn't been invited")
	ErrDisabled        = errors.New("this account is disabled")
	ErrUnverifiedEmail = errors.New("the Google account's email isn't verified")
	ErrNotFound        = errors.New("not found")
	ErrConflict        = errors.New("already exists")
	ErrInvalidEmail    = errors.New("invalid email address")
	ErrForbidden       = errors.New("not permitted")
)

// User is an account.
type User struct {
	ID         string
	Email      string
	Name       string
	ImageURL   string
	Role       string
	Status     string
	CreatedAt  time.Time
	LastSeenAt *time.Time
	// Owner is true for configured superuser emails, which can't be changed
	// from the admin portal.
	Owner bool
}

// IsSuperuser reports whether the user may use the admin portal.
func (u User) IsSuperuser() bool { return u.Role == RoleSuperuser }

// Identity is what an identity provider asserts about a person.
type Identity struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	Picture       string
}

// Store reads and writes accounts.
type Store struct {
	db  *sql.DB
	cfg *config.Config
	now func() time.Time
}

// NewStore returns a Store.
func NewStore(database *sql.DB, cfg *config.Config) *Store {
	return &Store{db: database, cfg: cfg, now: time.Now}
}

// SetClock replaces the clock (tests).
func (s *Store) SetClock(now func() time.Time) { s.now = now }

const userColumns = `id, email, name, coalesce(image_url, ''), role, status, created_at, last_seen_at`

func (s *Store) scanUser(row interface{ Scan(...any) error }) (User, error) {
	var (
		user      User
		createdAt string
		lastSeen  sql.NullString
	)
	if err := row.Scan(&user.ID, &user.Email, &user.Name, &user.ImageURL, &user.Role, &user.Status, &createdAt, &lastSeen); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	user.CreatedAt, _ = db.ParseTime(createdAt)
	if lastSeen.Valid {
		if t, err := db.ParseTime(lastSeen.String); err == nil {
			user.LastSeenAt = &t
		}
	}
	user.Owner = s.cfg.IsSuperuserEmail(user.Email)
	return user, nil
}

// GetUser returns the user with id.
func (s *Store) GetUser(ctx context.Context, id string) (User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

// SignIn applies the sign-in policy to an identity and returns the user,
// creating or updating it. A person may sign in when their email is a
// configured superuser, belongs to an existing active user, or is invited.
func (s *Store) SignIn(ctx context.Context, identity Identity) (User, error) {
	email := config.NormalizeEmail(identity.Email)
	if email == "" || identity.Subject == "" {
		return User{}, ErrNotAllowed
	}
	if !identity.EmailVerified {
		return User{}, ErrUnverifiedEmail
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback() //nolint:errcheck // rollback after commit is a no-op

	// Match on the stable Google subject first, then on email (accounts
	// created by an invite or imported from the old database have no subject
	// until their first sign-in).
	existing, err := s.scanUser(tx.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE google_sub = ?`, identity.Subject))
	if errors.Is(err, ErrNotFound) {
		existing, err = s.scanUser(tx.QueryRowContext(ctx,
			`SELECT `+userColumns+` FROM users WHERE email = ? AND (google_sub IS NULL OR google_sub = ?)`,
			email, identity.Subject))
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return User{}, err
	}
	found := err == nil
	owner := s.cfg.IsSuperuserEmail(email)
	now := db.FormatTime(s.now())

	if found {
		if existing.Status == StatusDisabled && !owner {
			return User{}, ErrDisabled
		}
		role := existing.Role
		if owner {
			role = RoleSuperuser
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE users SET google_sub = ?, email = ?, name = ?, image_url = ?, role = ?,
				status = ?, last_seen_at = ?, updated_at = ?
			WHERE id = ?`,
			identity.Subject, email, nonEmpty(identity.Name, existing.Name), nullable(identity.Picture),
			role, StatusActive, now, now, existing.ID); err != nil {
			return User{}, err
		}
		if err := tx.Commit(); err != nil {
			return User{}, err
		}
		return s.GetUser(ctx, existing.ID)
	}

	if !owner {
		var invited int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM allowed_emails WHERE email = ?`, email).Scan(&invited); err != nil {
			return User{}, err
		}
		if invited == 0 {
			return User{}, ErrNotAllowed
		}
	}

	role := RoleMember
	if owner {
		role = RoleSuperuser
	}
	id := uuid.NewString()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, email, name, image_url, google_sub, role, status, created_at, updated_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, email, identity.Name, nullable(identity.Picture), identity.Subject, role, StatusActive, now, now, now); err != nil {
		if isUniqueViolation(err) {
			return User{}, ErrConflict
		}
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.GetUser(ctx, id)
}

// DevSignIn signs in an allowed email without an identity provider. It is
// only wired up when development sign-in is enabled.
func (s *Store) DevSignIn(ctx context.Context, email string) (User, error) {
	email = config.NormalizeEmail(email)
	if _, err := mail.ParseAddress(email); err != nil {
		return User{}, ErrInvalidEmail
	}
	return s.SignIn(ctx, Identity{
		Subject:       "dev:" + email,
		Email:         email,
		EmailVerified: true,
		Name:          strings.Split(email, "@")[0],
	})
}

// --- Sessions -------------------------------------------------------------

// SessionMeta describes where a session was created.
type SessionMeta struct {
	UserAgent string
	IP        string
}

// CreateSession issues a new session token for userID. Only the token's hash
// is stored; the token itself goes into the cookie and nowhere else.
func (s *Store) CreateSession(ctx context.Context, userID string, meta SessionMeta) (string, time.Time, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	now := s.now()
	expires := now.Add(SessionTTL)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, user_agent, ip)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		hashToken(token), userID, db.FormatTime(now), db.FormatTime(expires), db.FormatTime(now),
		truncate(meta.UserAgent, 300), truncate(meta.IP, 64))
	if err != nil {
		return "", time.Time{}, err
	}
	return token, expires, nil
}

// SessionUser resolves a session token to its active user. When the session
// was last extended more than a day ago it is extended again, and the new
// expiry is returned so the caller can refresh the cookie; otherwise the
// returned time is zero.
func (s *Store) SessionUser(ctx context.Context, token string) (User, time.Time, error) {
	if token == "" {
		return User{}, time.Time{}, ErrNotFound
	}
	hash := hashToken(token)
	var expiresAt, lastUsedAt string
	var userID string
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id, expires_at, last_used_at FROM sessions WHERE token_hash = ?`, hash,
	).Scan(&userID, &expiresAt, &lastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return User{}, time.Time{}, err
	}
	now := s.now()
	expires, err := db.ParseTime(expiresAt)
	if err != nil || !now.Before(expires) {
		_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, hash)
		return User{}, time.Time{}, ErrNotFound
	}
	user, err := s.GetUser(ctx, userID)
	if err != nil {
		return User{}, time.Time{}, err
	}
	if user.Status != StatusActive {
		return User{}, time.Time{}, ErrDisabled
	}

	var renewed time.Time
	lastUsed, _ := db.ParseTime(lastUsedAt)
	if now.Sub(lastUsed) >= sessionRefreshStep {
		renewed = now.Add(SessionTTL)
		if _, err := s.db.ExecContext(ctx,
			`UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE token_hash = ?`,
			db.FormatTime(renewed), db.FormatTime(now), hash); err != nil {
			return User{}, time.Time{}, err
		}
		if _, err := s.db.ExecContext(ctx,
			`UPDATE users SET last_seen_at = ? WHERE id = ?`, db.FormatTime(now), user.ID); err != nil {
			return User{}, time.Time{}, err
		}
	}
	return user, renewed, nil
}

// DeleteSession ends one session.
func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, hashToken(token))
	return err
}

// PurgeExpiredSessions removes sessions past their expiry.
func (s *Store) PurgeExpiredSessions(ctx context.Context) (int64, error) {
	result, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, db.FormatTime(s.now()))
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// --- Administration -------------------------------------------------------

// UserSummary is a user plus figures for the admin portal.
type UserSummary struct {
	User
	ActiveSessions int
}

// ListUsers returns every user, owners first, then by creation time.
func (s *Store) ListUsers(ctx context.Context) ([]UserSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+userColumns+`,
			(SELECT count(*) FROM sessions WHERE sessions.user_id = users.id AND sessions.expires_at > ?)
		FROM users ORDER BY created_at ASC`, db.FormatTime(s.now()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []UserSummary
	for rows.Next() {
		var (
			summary   UserSummary
			createdAt string
			lastSeen  sql.NullString
		)
		if err := rows.Scan(&summary.ID, &summary.Email, &summary.Name, &summary.ImageURL, &summary.Role,
			&summary.Status, &createdAt, &lastSeen, &summary.ActiveSessions); err != nil {
			return nil, err
		}
		summary.CreatedAt, _ = db.ParseTime(createdAt)
		if lastSeen.Valid {
			if t, err := db.ParseTime(lastSeen.String); err == nil {
				summary.LastSeenAt = &t
			}
		}
		summary.Owner = s.cfg.IsSuperuserEmail(summary.Email)
		out = append(out, summary)
	}
	return out, rows.Err()
}

// UserUpdate is a partial change to a user. Nil fields are left alone.
type UserUpdate struct {
	Role   *string
	Status *string
}

// UpdateUser changes another user's role or status. Superusers can't change
// themselves (so they can't lock themselves out) or a configured owner.
// Disabling a user ends all of their sessions.
func (s *Store) UpdateUser(ctx context.Context, actor User, id string, update UserUpdate) (User, error) {
	if update.Role != nil && *update.Role != RoleSuperuser && *update.Role != RoleMember {
		return User{}, fmt.Errorf("%w: unknown role %q", ErrForbidden, *update.Role)
	}
	if update.Status != nil && *update.Status != StatusActive && *update.Status != StatusDisabled {
		return User{}, fmt.Errorf("%w: unknown status %q", ErrForbidden, *update.Status)
	}
	target, err := s.GetUser(ctx, id)
	if err != nil {
		return User{}, err
	}
	if target.ID == actor.ID {
		return User{}, fmt.Errorf("%w: you can't change your own account", ErrForbidden)
	}
	if target.Owner {
		return User{}, fmt.Errorf("%w: owner accounts are managed by configuration", ErrForbidden)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback() //nolint:errcheck
	now := db.FormatTime(s.now())
	if update.Role != nil {
		if _, err := tx.ExecContext(ctx, `UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, *update.Role, now, id); err != nil {
			return User{}, err
		}
	}
	if update.Status != nil {
		if _, err := tx.ExecContext(ctx, `UPDATE users SET status = ?, updated_at = ? WHERE id = ?`, *update.Status, now, id); err != nil {
			return User{}, err
		}
		if *update.Status == StatusDisabled {
			if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, id); err != nil {
				return User{}, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.GetUser(ctx, id)
}

// DeleteUser removes another user and everything they own. It also removes
// their invite, so they can't sign straight back in.
func (s *Store) DeleteUser(ctx context.Context, actor User, id string) (User, error) {
	target, err := s.GetUser(ctx, id)
	if err != nil {
		return User{}, err
	}
	if target.ID == actor.ID {
		return User{}, fmt.Errorf("%w: you can't delete your own account", ErrForbidden)
	}
	if target.Owner {
		return User{}, fmt.Errorf("%w: owner accounts are managed by configuration", ErrForbidden)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id); err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM allowed_emails WHERE email = ?`, target.Email); err != nil {
		return User{}, err
	}
	return target, tx.Commit()
}

// Invite is an allowlisted email.
type Invite struct {
	Email      string
	InvitedBy  *User
	CreatedAt  time.Time
	AcceptedBy *string // user id once someone with this email has signed in
}

// ListInvites returns every invite, newest first.
func (s *Store) ListInvites(ctx context.Context) ([]Invite, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT a.email, a.created_at, a.invited_by, coalesce(inviter.email, ''), coalesce(inviter.name, ''), member.id
		FROM allowed_emails a
		LEFT JOIN users inviter ON inviter.id = a.invited_by
		LEFT JOIN users member ON member.email = a.email
		ORDER BY a.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Invite
	for rows.Next() {
		var (
			invite                    Invite
			createdAt                 string
			inviterID, accepted       sql.NullString
			inviterEmail, inviterName string
		)
		if err := rows.Scan(&invite.Email, &createdAt, &inviterID, &inviterEmail, &inviterName, &accepted); err != nil {
			return nil, err
		}
		invite.CreatedAt, _ = db.ParseTime(createdAt)
		if inviterID.Valid {
			invite.InvitedBy = &User{ID: inviterID.String, Email: inviterEmail, Name: inviterName}
		}
		if accepted.Valid {
			invite.AcceptedBy = &accepted.String
		}
		out = append(out, invite)
	}
	return out, rows.Err()
}

// CreateInvite allowlists an email.
func (s *Store) CreateInvite(ctx context.Context, actor User, rawEmail string) (string, error) {
	email := config.NormalizeEmail(rawEmail)
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email || len(email) > 254 {
		return "", ErrInvalidEmail
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO allowed_emails (email, invited_by, created_at) VALUES (?, ?, ?)`,
		email, actor.ID, db.FormatTime(s.now()))
	if isUniqueViolation(err) {
		return "", ErrConflict
	}
	return email, err
}

// DeleteInvite removes an invite. People who have already signed in keep
// their account; disable or delete the user to remove their access.
func (s *Store) DeleteInvite(ctx context.Context, rawEmail string) (string, error) {
	email := config.NormalizeEmail(rawEmail)
	result, err := s.db.ExecContext(ctx, `DELETE FROM allowed_emails WHERE email = ?`, email)
	if err != nil {
		return "", err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return "", ErrNotFound
	}
	return email, nil
}

// Counts summarizes accounts for the dashboard.
type Counts struct {
	Users          int
	Active         int
	Disabled       int
	Superusers     int
	PendingInvites int
	ActiveSessions int
}

// CountAccounts returns account figures.
func (s *Store) CountAccounts(ctx context.Context) (Counts, error) {
	var counts Counts
	err := s.db.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM users),
			(SELECT count(*) FROM users WHERE status = 'active'),
			(SELECT count(*) FROM users WHERE status = 'disabled'),
			(SELECT count(*) FROM users WHERE role = 'superuser'),
			(SELECT count(*) FROM allowed_emails a WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.email = a.email)),
			(SELECT count(*) FROM sessions WHERE expires_at > ?)`,
		db.FormatTime(s.now()),
	).Scan(&counts.Users, &counts.Active, &counts.Disabled, &counts.Superusers, &counts.PendingInvites, &counts.ActiveSessions)
	return counts, err
}

// --- helpers --------------------------------------------------------------

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nonEmpty(preferred, fallback string) string {
	if strings.TrimSpace(preferred) != "" {
		return preferred
	}
	return fallback
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}
