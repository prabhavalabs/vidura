package db

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOpenAndMigrateIsRepeatable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "vidura.db")

	first, err := OpenAndMigrate(path)
	require.NoError(t, err)
	require.NoError(t, first.Close())

	// A second start on the same file must be a no-op, not an error.
	second, err := OpenAndMigrate(path)
	require.NoError(t, err)
	defer second.Close()

	var mode string
	require.NoError(t, second.QueryRow(`PRAGMA journal_mode`).Scan(&mode))
	assert.Equal(t, "wal", mode)

	var foreignKeys int
	require.NoError(t, second.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys))
	assert.Equal(t, 1, foreignKeys)

	var tables int
	require.NoError(t, second.QueryRow(
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'sessions', 'allowed_emails', 'audit_log')`,
	).Scan(&tables))
	assert.Equal(t, 4, tables)
}

func TestForeignKeysCascade(t *testing.T) {
	database, err := OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	defer database.Close()

	now := FormatTime(time.Now())
	_, err = database.Exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')`)
	require.NoError(t, err)
	_, err = database.Exec(
		`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at) VALUES ('h', 'u1', ?, ?, ?)`,
		now, now, now)
	require.NoError(t, err)

	_, err = database.Exec(`DELETE FROM users WHERE id = 'u1'`)
	require.NoError(t, err)

	var sessions int
	require.NoError(t, database.QueryRow(`SELECT count(*) FROM sessions`).Scan(&sessions))
	assert.Zero(t, sessions)
}

func TestTimeFormatSortsAsText(t *testing.T) {
	earlier := FormatTime(time.Date(2026, 1, 2, 3, 4, 5, 6_000_000, time.FixedZone("x", 5*3600)))
	later := FormatTime(time.Date(2026, 1, 2, 3, 4, 5, 7_000_000, time.FixedZone("x", 5*3600)))
	assert.Less(t, earlier, later)
	assert.Equal(t, "2026-01-01T22:04:05.006Z", earlier)

	parsed, err := ParseTime(earlier)
	require.NoError(t, err)
	assert.Equal(t, time.UTC, parsed.Location())
}
