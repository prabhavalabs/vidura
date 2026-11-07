package learn

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// Kinds of study notes.
var Kinds = map[string]bool{"summary": true, "flashcards": true, "quiz": true}

// Insight is one kind of study notes for a video, in one language.
type Insight struct {
	Kind   string `json:"kind"`
	Locale string `json:"locale"`
	// Status is "none" (never made), "pending", "ready" or "failed".
	Status    string          `json:"status"`
	Content   json.RawMessage `json:"content,omitempty"`
	Error     string          `json:"error,omitempty"`
	UpdatedAt string          `json:"updatedAt,omitempty"`
}

// The shapes the model must answer in. Every object lists all its fields
// as required and allows no others, as structured output requires.
func object(properties map[string]any) map[string]any {
	required := make([]string, 0, len(properties))
	for name := range properties {
		required = append(required, name)
	}
	return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
}

// array is a list of items; its size goes in the description, which the
// model follows (length keywords aren't supported by every output mode).
func array(items any, min, max int) map[string]any {
	size := fmt.Sprintf("Between %d and %d items.", min, max)
	if min == max {
		size = fmt.Sprintf("Exactly %d items.", min)
	}
	return map[string]any{"type": "array", "items": items, "description": size}
}

var (
	str = map[string]any{"type": "string"}
	ms  = map[string]any{"type": "integer", "description": "Where in the video this comes from, in milliseconds (from the transcript's [m:ss] marks)."}
)

var schemas = map[string]any{
	"summary": object(map[string]any{
		"title":    str,
		"overview": map[string]any{"type": "string", "description": "Three to five sentences: what the video teaches and why it matters."},
		"sections": array(object(map[string]any{
			"heading": str,
			"points":  array(str, 1, 6),
			"startMs": ms,
		}), 2, 10),
		"takeaways": array(str, 3, 7),
		"terms": array(object(map[string]any{
			"term":    str,
			"meaning": str,
		}), 0, 12),
	}),
	"flashcards": object(map[string]any{
		"cards": array(object(map[string]any{
			"front":   map[string]any{"type": "string", "description": "A question or prompt."},
			"back":    map[string]any{"type": "string", "description": "The answer, in one to three sentences."},
			"startMs": ms,
		}), 6, 16),
	}),
	"quiz": object(map[string]any{
		"questions": array(object(map[string]any{
			"question":    str,
			"options":     array(str, 4, 4),
			"answer":      map[string]any{"type": "integer", "description": "Index of the correct option, 0 to 3."},
			"explanation": str,
			"startMs":     ms,
		}), 5, 10),
	}),
}

var instructions = map[string]string{
	"summary": "You are Vidura, a patient tutor. Read the transcript of a YouTube video and write study notes " +
		"for a learner who wants to understand it well: a short title, an overview, sections that follow the " +
		"video in order (each with its key points and where it starts), the main takeaways, and the important " +
		"terms with simple meanings. Be accurate to the video; add nothing it doesn't say.",
	"flashcards": "You are Vidura, a patient tutor. Read the transcript of a YouTube video and make flashcards " +
		"that help a learner remember its most important ideas, facts and terms. Each card has a clear question " +
		"or prompt on the front and a short answer on the back, and says where in the video it comes from. Cover " +
		"the whole video, not just the start.",
	"quiz": "You are Vidura, a patient tutor. Read the transcript of a YouTube video and write a multiple-choice " +
		"quiz that checks real understanding, not trivia. Each question has four plausible options with exactly " +
		"one correct, a short explanation of why it's right, and where in the video the answer is. Vary which " +
		"option is correct.",
}

// GetInsight returns one kind of study notes for one of ownerID's videos.
func (s *Service) GetInsight(ctx context.Context, ownerID, videoID, kind, locale string) (Insight, error) {
	if !Kinds[kind] {
		return Insight{}, ErrBadKind
	}
	if !Locales[locale] {
		return Insight{}, ErrBadLocale
	}
	if err := s.ownsVideo(ctx, ownerID, videoID); err != nil {
		return Insight{}, err
	}
	return s.readInsight(ctx, videoID, kind, locale)
}

func (s *Service) readInsight(ctx context.Context, videoID, kind, locale string) (Insight, error) {
	in := Insight{Kind: kind, Locale: locale, Status: "none"}
	var content, message sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT status, content, error_message, updated_at FROM video_insights
		WHERE video_id = ? AND kind = ? AND locale = ?`, videoID, kind, locale).
		Scan(&in.Status, &content, &message, &in.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return in, nil
	}
	if err != nil {
		return Insight{}, err
	}
	if content.Valid {
		in.Content = json.RawMessage(content.String)
	}
	in.Error = message.String
	return in, nil
}

func (s *Service) ownsVideo(ctx context.Context, ownerID, videoID string) error {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM videos WHERE id = ? AND owner_id = ?`,
		videoID, ownerID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// MakeInsight starts making study notes (again, when they exist) and returns
// them as pending. Notes already being made are returned as they are.
func (s *Service) MakeInsight(ctx context.Context, ownerID, videoID, kind, locale string) (Insight, error) {
	current, err := s.GetInsight(ctx, ownerID, videoID, kind, locale)
	if err != nil {
		return Insight{}, err
	}
	if current.Status == "pending" {
		return current, nil
	}
	if _, err := s.task(ctx, "summary"); err != nil {
		return Insight{}, err
	}
	if n, err := s.pendingCount(ctx, ownerID); err != nil {
		return Insight{}, err
	} else if n >= maxPending {
		return Insight{}, ErrBusy
	}
	v, err := s.loadVideo(ctx, ownerID, videoID)
	if err != nil {
		return Insight{}, err
	}
	now := db.FormatTime(s.now())
	if _, err := s.db.ExecContext(ctx, `INSERT INTO video_insights (video_id, kind, locale, status, created_at, updated_at)
		VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT (video_id, kind, locale) DO UPDATE SET
		status = 'pending', error_message = NULL, updated_at = excluded.updated_at`,
		videoID, kind, locale, now, now); err != nil {
		return Insight{}, err
	}
	s.background(func() { s.makeInsight(v, kind, locale) })
	return s.readInsight(ctx, videoID, kind, locale)
}

func (s *Service) makeInsight(v video, kind, locale string) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	content, model, err := s.generateInsight(ctx, v, kind, locale)
	now := db.FormatTime(s.now())
	if err != nil {
		slog.Warn("learn: study notes failed", "video", v.ID, "kind", kind, "err", err)
		_, _ = s.db.ExecContext(ctx, `UPDATE video_insights SET status = 'failed', error_message = ?, updated_at = ?
			WHERE video_id = ? AND kind = ? AND locale = ?`, friendly(err), now, v.ID, kind, locale)
		s.learnFinished(v, kind, false)
		return
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE video_insights SET status = 'ready', content = ?, model = ?,
		error_message = NULL, updated_at = ? WHERE video_id = ? AND kind = ? AND locale = ?`,
		content, model, now, v.ID, kind, locale); err != nil {
		slog.Error("learn: save study notes", "video", v.ID, "err", err)
		return
	}
	s.learnFinished(v, kind, true)
}

func (s *Service) generateInsight(ctx context.Context, v video, kind, locale string) (string, string, error) {
	task, err := s.task(ctx, "summary")
	if err != nil {
		return "", "", err
	}
	result, err := s.ai.Exec(ctx, chatgpt.Request{
		System:  instructions[kind] + "\n" + languageRule(locale),
		Input:   v.transcript(false),
		Model:   task.Model,
		Effort:  task.Effort,
		Schema:  schemas[kind],
		Lane:    chatgpt.LaneStudy,
		Timeout: 10 * time.Minute,
	})
	if err != nil {
		return "", "", err
	}
	var check map[string]any
	if err := json.Unmarshal([]byte(result.Text), &check); err != nil {
		return "", "", fmt.Errorf("the model's answer wasn't valid: %w", err)
	}
	return result.Text, task.Model, nil
}

// friendly is the message stored for a failure.
func friendly(err error) string {
	switch {
	case errors.Is(err, chatgpt.ErrAuth):
		return chatgpt.ErrAuth.Error()
	case errors.Is(err, chatgpt.ErrQuota):
		return chatgpt.ErrQuota.Error()
	case errors.Is(err, context.DeadlineExceeded):
		return "It took too long. Please try again."
	}
	message := err.Error()
	if len(message) > 300 {
		message = message[:300]
	}
	return message
}
