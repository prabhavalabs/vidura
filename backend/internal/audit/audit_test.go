package audit

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

func TestRecordAndPaginate(t *testing.T) {
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	defer database.Close()
	log := New(database)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		log.Record(ctx, Entry{ActorEmail: "owner@example.com", Action: InviteCreated, Target: "x", Detail: map[string]any{"i": i}})
	}
	log.Record(ctx, Entry{Action: SignInRefused, Target: "stranger@example.com", IP: "203.0.113.9"})

	first, err := log.List(ctx, 4, "", "")
	require.NoError(t, err)
	require.Len(t, first.Entries, 4)
	assert.Equal(t, SignInRefused, first.Entries[0].Action, "newest first")
	assert.Equal(t, "203.0.113.9", first.Entries[0].IP)
	require.NotEmpty(t, first.NextCursor)

	second, err := log.List(ctx, 4, first.NextCursor, "")
	require.NoError(t, err)
	assert.Len(t, second.Entries, 2)
	assert.Empty(t, second.NextCursor)
	assert.EqualValues(t, 0, second.Entries[1].Detail["i"])

	refused, err := log.List(ctx, 50, "", SignInRefused)
	require.NoError(t, err)
	assert.Len(t, refused.Entries, 1)
}

func TestListPageFiltersAndCounts(t *testing.T) {
	log := newLog(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		log.Record(ctx, Entry{Action: SignIn})
	}
	log.Record(ctx, Entry{Action: UserDeleted})
	log.Record(ctx, Entry{Action: InviteCreated})

	all, err := log.ListPage(ctx, 1, 3, nil)
	require.NoError(t, err)
	assert.Equal(t, 7, all.Total)
	assert.Len(t, all.Entries, 3)
	assert.Equal(t, InviteCreated, all.Entries[0].Action, "newest first")

	last, err := log.ListPage(ctx, 3, 3, nil)
	require.NoError(t, err)
	assert.Len(t, last.Entries, 1)

	some, err := log.ListPage(ctx, 1, 10, []string{UserDeleted, InviteCreated})
	require.NoError(t, err)
	assert.Equal(t, 2, some.Total)
}

func newLog(t *testing.T) *Log {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })
	return New(database)
}
