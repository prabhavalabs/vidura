package accounts

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/mail"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/crypto/argon2"

	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// ErrWrongPassword is returned for an unknown email, an account without a
// password, or a wrong password alike, so the answer reveals nothing.
var ErrWrongPassword = errors.New("the email or password is wrong")

// ErrWeakPassword is returned by SetPassword for a password that is too short.
var ErrWeakPassword = errors.New("the password needs at least 8 characters")

// MinPasswordLength is the shortest password SetPassword accepts.
const MinPasswordLength = 8

// argon2id parameters (OWASP's recommended minimum is m=19 MiB, t=2).
const (
	argonMemory  = 64 * 1024 // KiB
	argonTime    = 3
	argonThreads = 2
	argonKeyLen  = 32
	argonSaltLen = 16
)

// HashPassword returns an argon2id hash in the PHC string format.
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// checkPassword verifies a password against a PHC argon2id hash in constant
// time. Malformed hashes never match.
func checkPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var version int
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false
	}
	if memory == 0 || memory > 1<<20 || iterations == 0 || iterations > 16 || threads == 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// dummyHash is checked when an account has no password, so a missing
// account takes as long to refuse as a wrong password.
var dummyHash, _ = HashPassword("vidura-timing-equaliser")

// SetPassword sets the password of the account with this email and signs out
// its existing sessions. A configured owner email without an account gets
// one, as a superuser.
func (s *Store) SetPassword(ctx context.Context, email, password string) (User, error) {
	email = config.NormalizeEmail(email)
	if _, err := mail.ParseAddress(email); err != nil {
		return User{}, ErrInvalidEmail
	}
	if len([]rune(password)) < MinPasswordLength {
		return User{}, ErrWeakPassword
	}
	if len(password) > 1024 {
		return User{}, errors.New("the password is too long")
	}
	hash, err := HashPassword(password)
	if err != nil {
		return User{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback() //nolint:errcheck // rollback after commit is a no-op
	now := db.FormatTime(s.now())
	var id string
	err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE email = ?`, email).Scan(&id)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if !s.cfg.IsSuperuserEmail(email) {
			return User{}, ErrNotFound
		}
		id = uuid.NewString()
		if _, err := tx.ExecContext(ctx, `INSERT INTO users (id, email, name, role, status, password_hash, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, email, strings.Split(email, "@")[0], RoleSuperuser, StatusActive, hash, now, now); err != nil {
			return User{}, err
		}
	case err != nil:
		return User{}, err
	default:
		if _, err := tx.ExecContext(ctx, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, hash, now, id); err != nil {
			return User{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, id); err != nil {
			return User{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.GetUser(ctx, id)
}

// PasswordSignIn checks an email and password. Owners are always
// superusers; disabled accounts are refused after the password matches.
func (s *Store) PasswordSignIn(ctx context.Context, email, password string) (User, error) {
	email = config.NormalizeEmail(email)
	var id string
	var hash sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT id, password_hash FROM users WHERE email = ?`, email).Scan(&id, &hash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return User{}, err
	}
	if err != nil || !hash.Valid || hash.String == "" {
		checkPassword(dummyHash, password)
		return User{}, ErrWrongPassword
	}
	if !checkPassword(hash.String, password) {
		return User{}, ErrWrongPassword
	}
	user, err := s.GetUser(ctx, id)
	if err != nil {
		return User{}, err
	}
	owner := s.cfg.IsSuperuserEmail(email)
	if user.Status == StatusDisabled && !owner {
		return User{}, ErrDisabled
	}
	role := user.Role
	if owner {
		role = RoleSuperuser
	}
	now := db.FormatTime(s.now())
	if _, err := s.db.ExecContext(ctx, `UPDATE users SET role = ?, status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
		role, StatusActive, now, now, id); err != nil {
		return User{}, err
	}
	return s.GetUser(ctx, id)
}
