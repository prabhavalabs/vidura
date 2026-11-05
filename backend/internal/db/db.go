// Package db opens the SQLite database and applies its migrations.
package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/golang-migrate/migrate/v4"
	migratesqlite "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// TimeLayout is how every timestamp is stored: UTC, millisecond precision,
// fixed width, so text comparison orders times correctly.
const TimeLayout = "2006-01-02T15:04:05.000Z"

// FormatTime renders t for storage.
func FormatTime(t time.Time) string { return t.UTC().Format(TimeLayout) }

// ParseTime reads a stored timestamp.
func ParseTime(value string) (time.Time, error) { return time.Parse(TimeLayout, value) }

// Open opens (creating if needed) the database at path with the settings the
// app relies on: WAL for concurrent readers, foreign keys, a busy timeout so
// writers wait instead of failing, and IMMEDIATE transactions so a
// read-then-write transaction takes the write lock up front and can't
// deadlock against another writer.
func Open(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	query := url.Values{}
	for _, pragma := range []string{
		"journal_mode(WAL)",
		"busy_timeout(10000)",
		"foreign_keys(1)",
		"synchronous(NORMAL)",
	} {
		query.Add("_pragma", pragma)
	}
	query.Set("_txlock", "immediate")

	db, err := sql.Open("sqlite", "file:"+path+"?"+query.Encode())
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetConnMaxIdleTime(5 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return db, nil
}

// Migrate applies every pending migration.
func Migrate(db *sql.DB) error {
	source, err := iofs.New(migrationFiles, "migrations")
	if err != nil {
		return fmt.Errorf("load migrations: %w", err)
	}
	driver, err := migratesqlite.WithInstance(db, &migratesqlite.Config{})
	if err != nil {
		return fmt.Errorf("migration driver: %w", err)
	}
	migrator, err := migrate.NewWithInstance("iofs", source, "sqlite", driver)
	if err != nil {
		return fmt.Errorf("migrator: %w", err)
	}
	if err := migrator.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

// OpenAndMigrate opens the database and brings its schema up to date.
func OpenAndMigrate(path string) (*sql.DB, error) {
	db, err := Open(path)
	if err != nil {
		return nil, err
	}
	if err := Migrate(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}
