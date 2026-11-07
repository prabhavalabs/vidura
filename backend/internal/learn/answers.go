package learn

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/push"
)

// Answers are written in the background, detached from the request that
// asked: leaving the page doesn't stop one. While the model writes, the text
// is kept here (and saved every second or so), and anyone following the
// answer is woken to send what's new. A listener reads the text it hasn't
// sent yet, so a slow one never holds up the model and never misses text,
// and one that connects late starts from the text so far.

// Answer statuses (chat_messages.status).
const (
	StatusStreaming = "streaming"
	StatusDone      = "done"
	StatusFailed    = "failed"
	StatusStopped   = "stopped"
)

// Failure codes (Message.Error); the app explains them in the learner's
// language.
const (
	FailQuota       = "quota"
	FailUnavailable = "ai_unavailable"
	FailTimeout     = "timeout"
	FailRestarted   = "restarted"
	FailOther       = "failed"
)

// ErrAnswering is returned when a conversation already has an answer being
// written, or an answer can't be retried.
var ErrAnswering = errors.New("wait for the tutor to finish the current answer")

// maxAnswering bounds how many answers one person can have being written.
const maxAnswering = 3

// answerTimeout is how long the model may take for one answer.
const answerTimeout = 3 * time.Minute

// saveEvery is how often a partial answer is saved, so reopening the
// conversation elsewhere shows it.
const saveEvery = time.Second

// pingEvery keeps a quiet stream open through proxies.
const pingEvery = 15 * time.Second

var errStopped = errors.New("stopped by the learner")

type answerSet struct {
	mu      sync.Mutex
	running map[string]*answer // by message ID
}

// answer is a tutor answer being written.
type answer struct {
	id, ownerID, threadID string
	// ctx is the writing's own context, not any request's.
	ctx    context.Context
	cancel context.CancelCauseFunc
	done   chan struct{} // closed once final is set

	mu      sync.Mutex
	text    string
	gen     int      // bumped when the model starts its answer over
	final   *Message // the finished answer
	waiters map[chan struct{}]struct{}
}

func newAnswer(id, ownerID, threadID string) *answer {
	ctx, cancel := context.WithCancelCause(context.Background())
	return &answer{id: id, ownerID: ownerID, threadID: threadID, ctx: ctx, cancel: cancel, done: make(chan struct{})}
}

func (a *answer) wakeLocked() {
	for ch := range a.waiters {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (set *answerSet) get(id string) *answer {
	set.mu.Lock()
	defer set.mu.Unlock()
	return set.running[id]
}

// add registers a new answer unless ownerID already has too many, or the
// thread already has one.
func (set *answerSet) add(a *answer) error {
	set.mu.Lock()
	defer set.mu.Unlock()
	if set.running == nil {
		set.running = map[string]*answer{}
	}
	mine := 0
	for _, other := range set.running {
		if other.threadID == a.threadID {
			return ErrAnswering
		}
		if other.ownerID == a.ownerID {
			mine++
		}
	}
	if mine >= maxAnswering {
		return ErrBusy
	}
	set.running[a.id] = a
	return nil
}

func (set *answerSet) remove(id string) {
	set.mu.Lock()
	defer set.mu.Unlock()
	delete(set.running, id)
}

// threadBusy reports whether threadID has an answer being written.
func (set *answerSet) threadBusy(threadID string) bool {
	set.mu.Lock()
	defer set.mu.Unlock()
	for _, a := range set.running {
		if a.threadID == threadID {
			return true
		}
	}
	return false
}

// stopThread stops the answer being written in threadID (it was deleted).
func (set *answerSet) stopThread(threadID string) {
	set.mu.Lock()
	defer set.mu.Unlock()
	for _, a := range set.running {
		if a.threadID == threadID {
			a.cancel(errStopped)
		}
	}
}

// text returns a running answer's text so far, if it is running.
func (set *answerSet) text(id string) (string, bool) {
	a := set.get(id)
	if a == nil {
		return "", false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.text, true
}

// recoverAnswers fails answers that were being written when the server
// stopped: nothing is writing them any more.
func (s *Service) recoverAnswers(ctx context.Context) {
	if _, err := s.db.ExecContext(ctx, `UPDATE chat_messages SET status = 'failed', error_message = ?
		WHERE status = 'streaming'`, FailRestarted); err != nil {
		slog.Warn("learn: recover answers", "err", err)
	}
}

// start writes the answer in the background. The answer row exists (status
// streaming) and a is registered.
func (s *Service) start(a *answer, req chatgpt.Request, notice notice) {
	s.background(func() {
		defer a.cancel(nil)
		s.write(a.ctx, a, req, notice)
	})
}

// notice is what the notification about a finished answer says.
type notice struct {
	title, url, locale string
}

func (s *Service) write(ctx context.Context, a *answer, req chatgpt.Request, n notice) {
	saved := time.Now()
	onDelta := func(d chatgpt.Delta) {
		a.mu.Lock()
		if d.Restart {
			a.text = ""
			a.gen++
		}
		a.text += d.Text
		text := a.text
		a.wakeLocked()
		a.mu.Unlock()
		if time.Since(saved) >= saveEvery {
			saved = time.Now()
			if _, err := s.db.ExecContext(ctx, `UPDATE chat_messages SET content = ? WHERE id = ? AND status = 'streaming'`,
				text, a.id); err != nil && ctx.Err() == nil {
				slog.Warn("learn: save partial answer", "message", a.id, "err", err)
			}
		}
	}

	var result chatgpt.Result
	var err error
	if streamer, ok := s.ai.(Streamer); ok {
		result, err = streamer.Stream(ctx, req, onDelta)
	} else {
		// A model without streaming: the answer arrives in one piece.
		if result, err = s.ai.Exec(ctx, req); err == nil {
			onDelta(chatgpt.Delta{Restart: true, Text: result.Text})
		}
	}

	a.mu.Lock()
	partial := a.text
	a.mu.Unlock()
	status, content, failure := StatusDone, strings.TrimSpace(result.Text), ""
	switch {
	case errors.Is(context.Cause(ctx), errStopped):
		status, content = StatusStopped, strings.TrimSpace(partial)
	case err != nil:
		status, content, failure = StatusFailed, strings.TrimSpace(partial), failCode(err)
		slog.Warn("learn: answer failed", "message", a.id, "err", err)
	}

	// The request that asked is long gone; finish with a fresh context.
	saveCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var errorMessage any
	if failure != "" {
		errorMessage = failure
	}
	now := db.FormatTime(s.now())
	if _, err := s.db.ExecContext(saveCtx, `UPDATE chat_messages SET content = ?, status = ?, error_message = ?
		WHERE id = ?`, content, status, errorMessage, a.id); err != nil {
		slog.Error("learn: save answer", "message", a.id, "err", err)
	}
	_, _ = s.db.ExecContext(saveCtx, `UPDATE chat_threads SET updated_at = ? WHERE id = ?`, now, a.threadID)

	final, lookupErr := s.message(saveCtx, a.ownerID, a.id)
	if lookupErr != nil {
		// Deleted with its conversation meanwhile: end the stream anyway.
		final = Message{ID: a.id, Role: "assistant", Content: content, Status: status, Error: failure}
	}
	a.mu.Lock()
	a.final = &final
	listening := len(a.waiters)
	a.wakeLocked()
	a.mu.Unlock()
	close(a.done)
	// From here the saved row is the answer; the conversation is free.
	s.answering.remove(a.id)

	// Someone watching the stream already sees it; otherwise say so. A
	// stopped answer needs no news: the learner stopped it.
	if listening == 0 && status != StatusStopped && lookupErr == nil {
		s.notifyAnswer(saveCtx, a, final, n)
	}
}

func failCode(err error) string {
	switch {
	case errors.Is(err, chatgpt.ErrQuota):
		return FailQuota
	case errors.Is(err, chatgpt.ErrAuth), errors.Is(err, chatgpt.ErrNotInstalled), errors.Is(err, ErrNoAI):
		return FailUnavailable
	case strings.Contains(err.Error(), "didn't answer within"):
		return FailTimeout
	}
	return FailOther
}

// Streamer is an AI that reports an answer as it is written
// (chatgpt.Manager). Without it, an answer arrives in one piece.
type Streamer interface {
	Stream(ctx context.Context, req chatgpt.Request, onDelta func(chatgpt.Delta)) (chatgpt.Result, error)
}

// Event is one step of an answer's live stream.
type Event struct {
	// Type is "snapshot" (Text is the whole answer so far, replacing what
	// was shown), "delta" (Text continues it), "end" (Message is the
	// finished answer: done, failed or stopped) or "ping" (nothing new).
	Type    string   `json:"-"`
	Text    string   `json:"text,omitempty"`
	Message *Message `json:"message,omitempty"`
}

// Follow streams one of ownerID's answers to emit: the text so far, then
// each new piece, then the finished answer. An answer that already ended is
// sent at once. It returns when the answer ends, emit fails or ctx is done.
func (s *Service) Follow(ctx context.Context, ownerID, messageID string, emit func(Event) error) error {
	a := s.answering.get(messageID)
	if a == nil || a.ownerID != ownerID {
		m, err := s.message(ctx, ownerID, messageID)
		if err != nil {
			return err
		}
		if m.Role != "assistant" {
			return ErrNotFound
		}
		if err := emit(Event{Type: "snapshot", Text: m.Content}); err != nil {
			return err
		}
		return emit(Event{Type: "end", Message: &m})
	}

	wake := make(chan struct{}, 1)
	a.mu.Lock()
	if a.waiters == nil {
		a.waiters = map[chan struct{}]struct{}{}
	}
	a.waiters[wake] = struct{}{}
	text, gen, final := a.text, a.gen, a.final
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.waiters, wake)
		a.mu.Unlock()
	}()

	if err := emit(Event{Type: "snapshot", Text: text}); err != nil {
		return err
	}
	sent := len(text)
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		if final != nil {
			return emit(Event{Type: "end", Message: final})
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ping.C:
			if err := emit(Event{Type: "ping"}); err != nil {
				return err
			}
			continue
		case <-wake:
		}
		a.mu.Lock()
		text, final = a.text, a.final
		restarted := a.gen != gen
		gen = a.gen
		a.mu.Unlock()
		switch {
		case restarted:
			if err := emit(Event{Type: "snapshot", Text: text}); err != nil {
				return err
			}
		case len(text) > sent:
			// Text only grows by whole pieces, so this cut is at a piece's
			// edge and never splits a character.
			if err := emit(Event{Type: "delta", Text: text[sent:]}); err != nil {
				return err
			}
		}
		sent = len(text)
	}
}

// Stop stops one of ownerID's answers being written, keeping what was
// written so far, and returns it. An answer that already ended is returned
// as it is.
func (s *Service) Stop(ctx context.Context, ownerID, messageID string) (Message, error) {
	a := s.answering.get(messageID)
	if a == nil || a.ownerID != ownerID {
		return s.message(ctx, ownerID, messageID)
	}
	a.cancel(errStopped)
	select {
	case <-a.done:
	case <-ctx.Done():
		return Message{}, ctx.Err()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return *a.final, nil
}

// notifyAnswer tells the learner their answer is ready (or failed), with a
// link back to the conversation, in their language.
func (s *Service) notifyAnswer(ctx context.Context, a *answer, m Message, n notice) {
	if s.notifier == nil {
		return
	}
	var locale string
	if err := s.db.QueryRowContext(ctx, `SELECT coalesce(locale, 'en') FROM users WHERE id = ?`, a.ownerID).Scan(&locale); err != nil {
		locale = n.locale
	}
	msg := push.Message{Title: n.title, URL: n.url, Tag: "chat-" + a.threadID, Kind: "chat_answer"}
	if msg.Title == "" {
		msg.Title = "Vidura"
	}
	switch {
	case m.Status == StatusDone:
		msg.Body = "Vidura: " + snippet(m.Content, 140)
	case locale == "si":
		msg.Kind = "chat_failed"
		msg.Body = "Vidura හට ඔබේ ප්‍රශ්නයට පිළිතුරු දීමට නොහැකි විය. නැවත උත්සාහ කිරීමට තට්ටු කරන්න."
	default:
		msg.Kind = "chat_failed"
		msg.Body = "Vidura couldn’t answer your question. Tap to try again."
	}
	if _, err := s.notifier.Send(ctx, a.ownerID, msg); err != nil {
		slog.Warn("learn: notify answer", "message", a.id, "err", err)
	}
}

var (
	markdownMarks = regexp.MustCompile("[*_`#>]+")
	bracketTimes  = regexp.MustCompile(`\[(\d{1,2}:\d{2}(?::\d{2})?)\]`)
	listMarks     = regexp.MustCompile(`(?m)^\s*(?:[-+]|\d+\.)\s+`)
)

// snippet is the start of an answer as plain text, for a notification.
func snippet(markdown string, limit int) string {
	text := bracketTimes.ReplaceAllString(markdown, "$1")
	text = listMarks.ReplaceAllString(text, "")
	text = markdownMarks.ReplaceAllString(text, "")
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}
