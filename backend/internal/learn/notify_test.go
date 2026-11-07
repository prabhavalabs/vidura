package learn

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/push"
)

func TestFinishedStudyNotesAreNotified(t *testing.T) {
	f := newFixture(t)
	notifier := push.New(f.db, "https://vidura.example.com")
	f.svc.SetNotifier(notifier)
	ctx := context.Background()

	_, err := f.svc.MakeInsight(ctx, "owner", "v1", "flashcards", "en")
	require.NoError(t, err)
	f.ai.answer = func(chatgpt.Request) (chatgpt.Result, error) { return chatgpt.Result{}, chatgpt.ErrQuota }
	_, err = f.svc.MakeInsight(ctx, "owner", "v1", "quiz", "en")
	require.NoError(t, err)

	list, unread, err := notifier.Notifications(ctx, "owner", 0)
	require.NoError(t, err)
	assert.Equal(t, 2, unread)
	require.Len(t, list, 2)
	assert.Equal(t, "notes_failed", list[0].Kind)
	assert.Equal(t, "notes_ready", list[1].Kind)
	assert.Equal(t, "How neurons talk", list[1].Title)
	assert.Equal(t, "/watch/v1?tab=learn", list[1].URL)
	assert.Contains(t, list[1].Body, "flashcards")

	others, _, _ := notifier.Notifications(ctx, "other", 0)
	assert.Empty(t, others)
}
