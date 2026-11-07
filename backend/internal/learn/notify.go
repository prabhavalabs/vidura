package learn

import (
	"context"

	"github.com/prabhavalabs/vidura/backend/internal/push"
)

// Notifier sends the notifications for work that finishes after the request
// that started it (push.Service). Each call records the notification for the
// app's unread list and pushes it to devices whose app isn't on screen.
type Notifier interface {
	Send(ctx context.Context, ownerID string, m push.Message) (int, error)
	LearnFinished(ownerID, videoID, videoTitle, what string, ok bool)
}

// SetNotifier turns notifications on. Call it before serving requests.
func (s *Service) SetNotifier(n Notifier) { s.notifier = n }

// learnFinished tells v's owner that study material (what: summary,
// flashcards, quiz or picture) is ready or failed.
func (s *Service) learnFinished(v video, what string, ok bool) {
	if s.notifier == nil {
		return
	}
	var owner string
	if err := s.db.QueryRow(`SELECT owner_id FROM videos WHERE id = ?`, v.ID).Scan(&owner); err != nil {
		return // the video was deleted meanwhile
	}
	s.notifier.LearnFinished(owner, v.ID, v.Title, what, ok)
}
