package settings

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

func store(t *testing.T) *Store {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })
	_, err = database.Exec(`INSERT INTO users (id, email) VALUES ('u1', 'owner@example.com')`)
	require.NoError(t, err)
	return NewStore(database)
}

func TestDefaultsAndUpdates(t *testing.T) {
	s := store(t)
	ctx := context.Background()

	current, err := s.Get(ctx)
	require.NoError(t, err)
	assert.Equal(t, Defaults.ASREngine, current.ASREngine)
	assert.Equal(t, Defaults.AI["chat"], current.AI["chat"])

	engine, off := "whisper", false
	updated, changed, err := s.Apply(ctx, "u1", Update{
		ASREngine:   &engine,
		ASRFallback: &off,
		AI:          map[string]TaskConfig{"translate": {Model: "gpt-6-sol", Effort: "high"}},
	})
	require.NoError(t, err)
	assert.Len(t, changed, 3)
	assert.Equal(t, "whisper", updated.ASREngine)
	assert.False(t, updated.ASRFallback)
	assert.Equal(t, TaskConfig{Model: "gpt-6-sol", Effort: "high"}, updated.AI["translate"])
	assert.Equal(t, Defaults.AI["summary"], updated.AI["summary"], "other tasks keep their defaults")
	assert.Equal(t, Defaults.AI["translate"].Model, "gpt-6.1-sol", "defaults aren't mutated")
}

func TestRejectsBadValues(t *testing.T) {
	s := store(t)
	ctx := context.Background()
	bad := "evil"
	cases := map[string]Update{
		"empty":        {},
		"engine":       {ASREngine: &bad},
		"task":         {AI: map[string]TaskConfig{"hack": {Model: "gpt-6-sol", Effort: "low"}}},
		"effort":       {AI: map[string]TaskConfig{"chat": {Model: "gpt-6-sol", Effort: "MAX!"}}},
		"model syntax": {AI: map[string]TaskConfig{"chat": {Model: "gpt 6; rm", Effort: "low"}}},
	}
	for name, update := range cases {
		_, _, err := s.Apply(ctx, "u1", update)
		assert.ErrorIs(t, err, ErrInvalid, name)
	}
}
