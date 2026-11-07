// Package learn turns a video's transcript into ways to learn from it:
// study notes (a summary, flashcards, a quiz), a tutor to chat with, and
// pictures that explain its ideas. Everything runs through the ChatGPT
// subscription (Codex CLI), in English or Sinhala.
//
// Every function takes the owner's ID: a video, chat or picture belonging
// to someone else is ErrNotFound.
package learn

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/pipeline"
	"github.com/prabhavalabs/vidura/backend/internal/settings"
)

// Errors.
var (
	ErrNotFound  = errors.New("not found")
	ErrNotReady  = errors.New("this video has no transcript yet")
	ErrBadKind   = errors.New("unknown kind of study notes")
	ErrBadLocale = errors.New("Vidura speaks English (en) and Sinhala (si)")
	ErrBusy      = errors.New("too many things are being made for you at once; try again in a minute")
	ErrNoAI      = errors.New("ChatGPT isn't connected on this server")
)

// AI runs one model call (chatgpt.Manager).
type AI interface {
	Exec(ctx context.Context, req chatgpt.Request) (chatgpt.Result, error)
}

// Service makes and stores study material.
type Service struct {
	db       *sql.DB
	ai       AI
	settings *settings.Store
	// imagesDir holds the pictures, one folder per video.
	imagesDir string
	now       func() time.Time
	// background runs work that outlives the request (tests run it inline).
	background func(func())
	// notifier tells people when background work finishes; nil in tests
	// and when push is off. See notify.go.
	notifier Notifier
	// answering holds the tutor answers being written. See answers.go.
	answering answerSet
}

// New returns a Service. ai may be nil (no ChatGPT): requests then fail with
// ErrNoAI.
func New(database *sql.DB, ai AI, store *settings.Store, imagesDir string) *Service {
	return &Service{
		db: database, ai: ai, settings: store, imagesDir: imagesDir, now: time.Now,
		background: func(f func()) { go f() },
	}
}

// Locales are the languages study material is made in.
var Locales = map[string]bool{"en": true, "si": true}

// maxPending bounds the study notes and pictures one person can have being
// made at once.
const maxPending = 4

// staleAfter is how long a "pending" row may wait before it's considered
// lost (the server restarted while making it).
const staleAfter = 15 * time.Minute

// Recover marks material that was being made when the server stopped as
// failed, so it can be asked for again.
func (s *Service) Recover(ctx context.Context) {
	cutoff := db.FormatTime(s.now().Add(-staleAfter))
	now := db.FormatTime(s.now())
	for _, table := range []string{"video_insights", "concept_images"} {
		if _, err := s.db.ExecContext(ctx, `UPDATE `+table+` SET status = 'failed',
			error_message = 'Vidura restarted while making this. Please try again.', updated_at = ?
			WHERE status = 'pending' AND updated_at < ?`, now, cutoff); err != nil {
			slog.Warn("learn: recover", "table", table, "err", err)
		}
	}
	s.recoverAnswers(ctx)
}

func (s *Service) pendingCount(ctx context.Context, ownerID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM video_insights i JOIN videos v ON v.id = i.video_id
			WHERE v.owner_id = ? AND i.status = 'pending')
		+ (SELECT count(*) FROM concept_images WHERE owner_id = ? AND status = 'pending')`,
		ownerID, ownerID).Scan(&n)
	return n, err
}

// task returns the model settings for an AI task ("summary" or "chat").
func (s *Service) task(ctx context.Context, name string) (settings.TaskConfig, error) {
	if s.ai == nil {
		return settings.TaskConfig{}, ErrNoAI
	}
	cfg, err := s.settings.Get(ctx)
	if err != nil {
		return settings.TaskConfig{}, err
	}
	task, ok := cfg.AI[name]
	if !ok || task.Model == "" {
		return settings.TaskConfig{}, fmt.Errorf("no model is set for %s in Settings", name)
	}
	return task, nil
}

// --- the source material ----------------------------------------------------

// video is what the prompts know about a video.
type video struct {
	ID       string
	Title    string
	Channel  string
	Duration int64
	Context  *pipeline.Context
	Lines    []line
}

type line struct {
	StartMs     int64
	Text        string
	Translation string
}

// maxTranscriptChars bounds the transcript sent to the model (about two and
// a half hours of speech); longer videos are sampled evenly.
const maxTranscriptChars = 180_000

// loadVideo reads one of ownerID's videos with its transcript.
func (s *Service) loadVideo(ctx context.Context, ownerID, videoID string) (video, error) {
	var v video
	var channel, contextRaw sql.NullString
	var duration sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT id, title, channel_title, duration_ms, translation_context
		FROM videos WHERE id = ? AND owner_id = ?`, videoID, ownerID).
		Scan(&v.ID, &v.Title, &channel, &duration, &contextRaw)
	if errors.Is(err, sql.ErrNoRows) {
		return video{}, ErrNotFound
	}
	if err != nil {
		return video{}, err
	}
	v.Channel, v.Duration = channel.String, duration.Int64
	if contextRaw.Valid {
		var c pipeline.Context
		if json.Unmarshal([]byte(contextRaw.String), &c) == nil {
			v.Context = &c
		}
	}
	rows, err := s.db.QueryContext(ctx, `SELECT s.start_ms, s.text, coalesce(t.text, '')
		FROM transcript_segments s
		LEFT JOIN translated_segments t ON t.segment_id = s.id AND t.language_code = 'si'
		WHERE s.video_id = ? ORDER BY s.segment_index`, videoID)
	if err != nil {
		return video{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var l line
		if err := rows.Scan(&l.StartMs, &l.Text, &l.Translation); err != nil {
			return video{}, err
		}
		v.Lines = append(v.Lines, l)
	}
	if err := rows.Err(); err != nil {
		return video{}, err
	}
	if len(v.Lines) == 0 {
		return video{}, ErrNotReady
	}
	return v, nil
}

// clock formats milliseconds as m:ss or h:mm:ss.
func clock(ms int64) string {
	total := ms / 1000
	h, m, sec := total/3600, (total%3600)/60, total%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, sec)
	}
	return fmt.Sprintf("%d:%02d", m, sec)
}

// transcript is the video as text for a prompt: a header, the glossary the
// translation used, and timestamped lines (English, with the Sinhala when
// withSinhala).
func (v video) transcript(withSinhala bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Title: %s\n", v.Title)
	if v.Channel != "" {
		fmt.Fprintf(&b, "Channel: %s\n", v.Channel)
	}
	if v.Duration > 0 {
		fmt.Fprintf(&b, "Length: %s\n", clock(v.Duration))
	}
	if v.Context != nil && len(v.Context.KeyTerms) > 0 {
		b.WriteString("Glossary used for the Sinhala subtitles:\n")
		for _, term := range v.Context.KeyTerms {
			fmt.Fprintf(&b, "- %s → %s\n", term.Source, term.PreferredSinhala)
		}
	}
	b.WriteString("\nTranscript:\n")
	lines := make([]string, len(v.Lines))
	size := 0
	for i, l := range v.Lines {
		text := fmt.Sprintf("[%s] %s", clock(l.StartMs), l.Text)
		if withSinhala && l.Translation != "" {
			text += " | " + l.Translation
		}
		lines[i] = text
		size += len(text) + 1
	}
	step := 1
	if size > maxTranscriptChars {
		step = size/maxTranscriptChars + 1
		b.WriteString("(Long video: every " + fmt.Sprint(step) + "th line is shown.)\n")
	}
	for i := 0; i < len(lines); i += step {
		b.WriteString(lines[i])
		b.WriteByte('\n')
	}
	return b.String()
}

// languageRule tells the model which language to write in.
func languageRule(locale string) string {
	if locale == "si" {
		return "Write everything for the learner in Sinhala (සිංහල), in the clear, natural style " +
			"Sri Lankans use for teaching. Keep a technical term in English in brackets after the Sinhala " +
			"the first time it appears, when that helps. Use the glossary's Sinhala terms where they fit."
	}
	return "Write everything for the learner in plain, friendly English."
}
