package learn

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// Thread is a conversation: about one video (VideoID set; one per video),
// or about the whole library (several).
type Thread struct {
	ID        string  `json:"id"`
	VideoID   *string `json:"videoId"`
	Title     string  `json:"title"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

// Message is one turn of a conversation.
type Message struct {
	ID        string `json:"id"`
	Role      string `json:"role"` // "user" or "assistant"
	Content   string `json:"content"`
	CreatedAt string `json:"createdAt"`
	// Voice is true for a question that was spoken.
	Voice bool `json:"voice,omitempty"`
	// Status is an answer's progress: streaming, done, failed or stopped.
	// Questions are always done.
	Status string `json:"status"`
	// Error says why an answer failed (a Fail* code).
	Error string `json:"error,omitempty"`
	// Video is the video a question was asked about with the "/" picker. On
	// an answer in a library conversation, it is the video the answer's
	// [m:ss] times point into.
	Video *VideoRef `json:"video,omitempty"`
}

// VideoRef names one of the learner's videos in a message.
type VideoRef struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	ThumbnailURL *string `json:"thumbnailUrl"`
}

// messageMeta is chat_messages.metadata.
type messageMeta struct {
	Voice   bool   `json:"voice,omitempty"`
	VideoID string `json:"videoId,omitempty"`
}

// MaxQuestion is the longest question accepted, in characters.
const MaxQuestion = 2000

// historyTurns is how many earlier messages the tutor sees.
const historyTurns = 12

// ErrEmptyQuestion is returned for a blank or overlong question.
var ErrEmptyQuestion = fmt.Errorf("ask a question of up to %d characters", MaxQuestion)

// Question is something a learner asks the tutor.
type Question struct {
	// VideoID asks in that video's conversation. Without it the question
	// goes to ThreadID's library conversation, or a new one when ThreadID
	// is empty.
	VideoID  string
	ThreadID string
	Text     string
	Locale   string
	Voice    bool
	// AttachedVideoID is a video picked with "/". A library question is
	// answered about it; in a video's conversation it is a second video to
	// relate the first to.
	AttachedVideoID string
}

// Ask puts a question to the tutor. The answer is written in the
// background, detached from ctx: Ask returns the question and the answer as
// it starts (status streaming), which Follow streams as it is written. It
// carries on if the learner leaves, and they're notified when it's done.
func (s *Service) Ask(ctx context.Context, ownerID string, q Question) (Thread, []Message, error) {
	q.Text = strings.TrimSpace(q.Text)
	if q.Text == "" || utf8.RuneCountInString(q.Text) > MaxQuestion {
		return Thread{}, nil, ErrEmptyQuestion
	}
	if !Locales[q.Locale] {
		return Thread{}, nil, ErrBadLocale
	}
	if _, err := s.task(ctx, "chat"); err != nil {
		return Thread{}, nil, err
	}

	var thread Thread
	var err error
	switch {
	case q.VideoID != "":
		var v video
		if v, err = s.loadVideo(ctx, ownerID, q.VideoID); err == nil {
			thread, err = s.videoThread(ctx, ownerID, q.VideoID, v.Title)
		}
	case q.ThreadID != "":
		thread, err = s.getThread(ctx, ownerID, q.ThreadID)
		if err == nil && thread.VideoID != nil {
			err = ErrNotFound
		}
	}
	if err != nil {
		return Thread{}, nil, err
	}
	history := []Message{}
	if thread.ID != "" {
		if s.answering.threadBusy(thread.ID) {
			return thread, nil, ErrAnswering
		}
		if history, err = s.Messages(ctx, ownerID, thread.ID); err != nil {
			return Thread{}, nil, err
		}
	}
	req, ref, err := s.prompt(ctx, ownerID, thread.VideoID, history, q.Text, q.AttachedVideoID, q.Locale)
	if err != nil {
		return thread, nil, err
	}
	// A new library conversation is made only once the question can be
	// answered, so a failure doesn't leave an empty one behind.
	if thread.ID == "" {
		if thread, err = s.newLibraryThread(ctx, ownerID, q.Text); err != nil {
			return Thread{}, nil, err
		}
	}

	now := db.FormatTime(s.now())
	asked := Message{ID: uuid.NewString(), Role: "user", Content: q.Text, CreatedAt: now, Voice: q.Voice,
		Status: StatusDone, Video: ref}
	reply := Message{ID: uuid.NewString(), Role: "assistant", CreatedAt: now, Status: StatusStreaming}
	if thread.VideoID == nil {
		reply.Video = ref
	}
	a := newAnswer(reply.ID, ownerID, thread.ID)
	if err := s.answering.add(a); err != nil {
		a.cancel(nil)
		return thread, nil, err
	}
	if err := s.insertTurn(ctx, ownerID, thread.ID, asked, reply); err != nil {
		s.answering.remove(a.id)
		a.cancel(nil)
		return thread, nil, err
	}
	s.start(a, req, s.noticeFor(thread, q.Locale))
	thread, _ = s.getThread(ctx, ownerID, thread.ID)
	return thread, []Message{asked, reply}, nil
}

// Retry writes a failed or stopped answer again, for the same question.
// Only a conversation's latest answer can be retried.
func (s *Service) Retry(ctx context.Context, ownerID, messageID, locale string) (Message, error) {
	if !Locales[locale] {
		return Message{}, ErrBadLocale
	}
	var threadID string
	err := s.db.QueryRowContext(ctx, `SELECT thread_id FROM chat_messages WHERE id = ? AND owner_id = ? AND role = 'assistant'`,
		messageID, ownerID).Scan(&threadID)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	if err != nil {
		return Message{}, err
	}
	thread, err := s.getThread(ctx, ownerID, threadID)
	if err != nil {
		return Message{}, err
	}
	all, err := s.Messages(ctx, ownerID, threadID)
	if err != nil {
		return Message{}, err
	}
	last := len(all) - 1
	if last < 1 || all[last].ID != messageID || all[last-1].Role != "user" ||
		(all[last].Status != StatusFailed && all[last].Status != StatusStopped) {
		return Message{}, ErrAnswering
	}
	question := all[last-1]
	attached := ""
	if question.Video != nil {
		attached = question.Video.ID
	}
	req, _, err := s.prompt(ctx, ownerID, thread.VideoID, all[:last-1], question.Content, attached, locale)
	if err != nil {
		return Message{}, err
	}
	a := newAnswer(messageID, ownerID, threadID)
	if err := s.answering.add(a); err != nil {
		a.cancel(nil)
		return Message{}, err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE chat_messages SET content = '', status = 'streaming', error_message = NULL
		WHERE id = ?`, messageID); err != nil {
		s.answering.remove(a.id)
		a.cancel(nil)
		return Message{}, err
	}
	s.start(a, req, s.noticeFor(thread, locale))
	return s.message(ctx, ownerID, messageID)
}

// noticeFor is how the notification about an answer in thread looks.
func (s *Service) noticeFor(thread Thread, locale string) notice {
	if thread.VideoID != nil {
		return notice{title: thread.Title, url: "/watch/" + *thread.VideoID + "?tab=ask", locale: locale}
	}
	return notice{title: thread.Title, url: "/ask/" + thread.ID, locale: locale}
}

// prompt is the model call answering question in a conversation (about
// threadVideo, or the library when nil) after history. It also returns the
// attached video, if any.
func (s *Service) prompt(ctx context.Context, ownerID string, threadVideo *string, history []Message,
	question, attachedID, locale string) (chatgpt.Request, *VideoRef, error) {
	task, err := s.task(ctx, "chat")
	if err != nil {
		return chatgpt.Request{}, nil, err
	}
	var material, rules string
	var ref *VideoRef
	if attachedID != "" && (threadVideo == nil || attachedID != *threadVideo) {
		if ref, err = s.videoRef(ctx, ownerID, attachedID); err != nil {
			return chatgpt.Request{}, nil, err
		}
	}
	switch {
	case threadVideo != nil:
		v, err := s.loadVideo(ctx, ownerID, *threadVideo)
		if err != nil {
			return chatgpt.Request{}, nil, err
		}
		rules = tutorRules(true, locale)
		if ref == nil {
			material = s.videoMaterial(ctx, v, locale, maxTranscriptChars)
			break
		}
		other, err := s.loadVideo(ctx, ownerID, ref.ID)
		if err != nil {
			return chatgpt.Request{}, nil, err
		}
		// Two transcripts share the room one has.
		material = s.videoMaterial(ctx, v, locale, maxTranscriptChars*2/3) +
			"\n\n=== Another video the learner attached ===\n" + s.videoMaterial(ctx, other, locale, maxTranscriptChars/3)
		rules += " The learner also attached another video, shown after the main one. When you refer to a moment " +
			"in that other video, name it and write its time without square brackets, like (its title, 3:05); " +
			"use [m:ss] only for the main video."
	case ref != nil:
		v, err := s.loadVideo(ctx, ownerID, ref.ID)
		if err != nil {
			return chatgpt.Request{}, nil, err
		}
		material = s.videoMaterial(ctx, v, locale, maxTranscriptChars)
		rules = tutorRules(true, locale)
	default:
		if material, err = s.libraryMaterial(ctx, ownerID, question); err != nil {
			return chatgpt.Request{}, nil, err
		}
		rules = tutorRules(false, locale)
	}
	return chatgpt.Request{
		System:  rules,
		Input:   conversation(material, history, question),
		Model:   task.Model,
		Effort:  task.Effort,
		Lane:    chatgpt.LaneChat,
		Timeout: answerTimeout,
	}, ref, nil
}

// videoRef names one of ownerID's videos that has a transcript.
func (s *Service) videoRef(ctx context.Context, ownerID, videoID string) (*VideoRef, error) {
	var ref VideoRef
	var thumbnail sql.NullString
	var lines int
	err := s.db.QueryRowContext(ctx, `SELECT v.id, v.title, v.thumbnail_url,
		(SELECT count(*) FROM transcript_segments s WHERE s.video_id = v.id)
		FROM videos v WHERE v.id = ? AND v.owner_id = ?`, videoID, ownerID).Scan(&ref.ID, &ref.Title, &thumbnail, &lines)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if lines == 0 {
		return nil, ErrNotReady
	}
	if thumbnail.Valid {
		ref.ThumbnailURL = &thumbnail.String
	}
	return &ref, nil
}

func tutorRules(aboutVideo bool, locale string) string {
	lang := "English"
	if locale == "si" {
		lang = "Sinhala (සිංහල)"
	}
	rules := "You are Vidura, a warm, patient tutor helping a Sri Lankan learner understand YouTube videos. " +
		"Answer in the language of the learner's latest question: if they wrote or spoke in Sinhala (or " +
		"Singlish), answer in natural Sinhala; if in English, answer in English. If you can't tell, answer in " + lang + ". " +
		"Explain simply, with examples when they help. Use short paragraphs and Markdown lists; no tables. " +
		"Base your answer on the material given; if it doesn't cover the question, say so briefly and then " +
		"answer from general knowledge, making clear which is which."
	if aboutVideo {
		rules += " When you refer to a moment in the video, write its time as [m:ss] (for example [3:05]) " +
			"so the learner can jump there."
	} else {
		rules += " The material lists the learner's videos and lines from them that match the question; " +
			"name the video when you use one."
	}
	return rules
}

// conversation is the prompt input: the material, earlier turns, the question.
func conversation(material string, history []Message, question string) string {
	var b strings.Builder
	b.WriteString("=== Material ===\n")
	b.WriteString(material)
	history = answered(history)
	if len(history) > historyTurns {
		history = history[len(history)-historyTurns:]
	}
	if len(history) > 0 {
		b.WriteString("\n=== Earlier in this conversation ===\n")
		for _, m := range history {
			who := "Learner"
			if m.Role == "assistant" {
				who = "Vidura"
			}
			fmt.Fprintf(&b, "%s: %s\n\n", who, m.Content)
		}
	}
	b.WriteString("\n=== The learner's question ===\n")
	b.WriteString(question)
	return b.String()
}

// answered keeps the turns that were answered: a question whose answer
// failed or was stopped, and that answer, are left out.
func answered(history []Message) []Message {
	var out []Message
	for i, m := range history {
		if m.Role == "user" {
			if i+1 < len(history) && history[i+1].Role == "assistant" && history[i+1].Status == StatusDone {
				out = append(out, m)
			}
			continue
		}
		if m.Status == StatusDone {
			out = append(out, m)
		}
	}
	return out
}

// videoMaterial is the video's transcript (with its Sinhala) in about limit
// characters, plus its study summary when one has been made.
func (s *Service) videoMaterial(ctx context.Context, v video, locale string, limit int) string {
	material := v.thinned(limit).transcript(true)
	for _, l := range []string{locale, "en", "si"} {
		in, err := s.readInsight(ctx, v.ID, "summary", l)
		if err == nil && in.Status == "ready" {
			material = "Study summary of the video:\n" + string(in.Content) + "\n\n" + material
			break
		}
	}
	return material
}

// thinned keeps every nth line, so the transcript fits in about limit
// characters. (transcript thins to maxTranscriptChars on its own; this is
// for sharing that room between two videos.)
func (v video) thinned(limit int) video {
	size := 0
	for _, l := range v.Lines {
		size += len(l.Text) + len(l.Translation) + 14
	}
	if size <= limit || limit <= 0 {
		return v
	}
	step := size/limit + 1
	out := v
	out.Lines = make([]line, 0, len(v.Lines)/step+1)
	for i := 0; i < len(v.Lines); i += step {
		out.Lines = append(out.Lines, v.Lines[i])
	}
	return out
}

// libraryMaterial lists the learner's videos (with overviews where study
// notes exist) and transcript lines matching the question's words.
func (s *Service) libraryMaterial(ctx context.Context, ownerID, question string) (string, error) {
	var b strings.Builder
	rows, err := s.db.QueryContext(ctx, `SELECT v.title, coalesce(v.channel_title, ''), v.created_at,
		(SELECT json_extract(i.content, '$.overview') FROM video_insights i
			WHERE i.video_id = v.id AND i.kind = 'summary' AND i.status = 'ready' LIMIT 1)
		FROM videos v WHERE v.owner_id = ? AND v.status = 'ready' ORDER BY v.created_at DESC LIMIT 200`, ownerID)
	if err != nil {
		return "", err
	}
	b.WriteString("The learner's videos (newest first):\n")
	count := 0
	for rows.Next() {
		var title, channel, created string
		var overview sql.NullString
		if err := rows.Scan(&title, &channel, &created, &overview); err != nil {
			rows.Close()
			return "", err
		}
		count++
		fmt.Fprintf(&b, "- %s", title)
		if channel != "" {
			fmt.Fprintf(&b, " (%s)", channel)
		}
		fmt.Fprintf(&b, ", added %s", created[:min(10, len(created))])
		if overview.Valid && overview.String != "" {
			fmt.Fprintf(&b, ": %s", overview.String)
		}
		b.WriteByte('\n')
	}
	rows.Close()
	if count == 0 {
		b.WriteString("(none yet)\n")
	}

	words := keywords(question)
	if len(words) == 0 {
		return b.String(), nil
	}
	clauses := make([]string, len(words))
	args := []any{ownerID}
	for i, word := range words {
		clauses[i] = "(lower(s.text) LIKE ? ESCAPE '\\' OR t.text LIKE ? ESCAPE '\\')"
		like := "%" + escapeLike(word) + "%"
		args = append(args, like, like)
	}
	lines, err := s.db.QueryContext(ctx, `SELECT v.title, s.start_ms, s.text, coalesce(t.text, '')
		FROM transcript_segments s
		JOIN videos v ON v.id = s.video_id
		LEFT JOIN translated_segments t ON t.segment_id = s.id AND t.language_code = 'si'
		WHERE v.owner_id = ? AND (`+strings.Join(clauses, " OR ")+`)
		ORDER BY v.created_at DESC, s.segment_index LIMIT 60`, args...)
	if err != nil {
		return "", err
	}
	defer lines.Close()
	b.WriteString("\nLines from those videos that match the question:\n")
	for lines.Next() {
		var title, text, sinhala string
		var start int64
		if err := lines.Scan(&title, &start, &text, &sinhala); err != nil {
			return "", err
		}
		fmt.Fprintf(&b, "- %s [%s] %s", title, clock(start), text)
		if sinhala != "" {
			fmt.Fprintf(&b, " | %s", sinhala)
		}
		b.WriteByte('\n')
	}
	return b.String(), lines.Err()
}

// keywords are a question's longer words (English lower-cased, Sinhala as
// is), for finding matching transcript lines.
func keywords(question string) []string {
	stop := map[string]bool{"what": true, "which": true, "where": true, "when": true, "does": true,
		"that": true, "this": true, "with": true, "from": true, "have": true, "about": true, "video": true,
		"videos": true, "there": true, "their": true, "they": true, "would": true, "could": true, "should": true,
		"explain": true, "tell": true}
	seen := map[string]bool{}
	var out []string
	for _, field := range strings.FieldsFunc(strings.ToLower(question), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r) && !unicode.Is(unicode.Mn, r) && !unicode.Is(unicode.Mc, r)
	}) {
		if utf8.RuneCountInString(field) < 4 || stop[field] {
			continue
		}
		field = stem(field)
		if seen[field] {
			continue
		}
		seen[field] = true
		out = append(out, field)
		if len(out) == 8 {
			break
		}
	}
	return out
}

// stem trims common English endings, because the search matches
// substrings: "synapses" → "synaps" finds "synapse", "firing" → "fir" finds
// "fire". Other scripts are left alone.
func stem(word string) string {
	for _, r := range word {
		if r > unicode.MaxASCII {
			return word
		}
	}
	for _, rule := range []struct {
		suffix string
		keep   int // shortest base to keep
	}{{"ing", 3}, {"ed", 3}, {"es", 4}, {"s", 4}} {
		if base, ok := strings.CutSuffix(word, rule.suffix); ok && len(base) >= rule.keep {
			return base
		}
	}
	return word
}

func escapeLike(term string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(term)
}

// --- threads -----------------------------------------------------------------

const threadColumns = `id, video_id, coalesce(title, ''), created_at, updated_at`

func scanThread(row interface{ Scan(...any) error }) (Thread, error) {
	var t Thread
	var videoID sql.NullString
	if err := row.Scan(&t.ID, &videoID, &t.Title, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return Thread{}, err
	}
	if videoID.Valid {
		t.VideoID = &videoID.String
	}
	return t, nil
}

func (s *Service) getThread(ctx context.Context, ownerID, id string) (Thread, error) {
	t, err := scanThread(s.db.QueryRowContext(ctx, `SELECT `+threadColumns+` FROM chat_threads
		WHERE id = ? AND owner_id = ?`, id, ownerID))
	if errors.Is(err, sql.ErrNoRows) {
		return Thread{}, ErrNotFound
	}
	return t, err
}

// VideoThread returns the conversation about one of ownerID's videos, if any.
func (s *Service) VideoThread(ctx context.Context, ownerID, videoID string) (*Thread, error) {
	if err := s.ownsVideo(ctx, ownerID, videoID); err != nil {
		return nil, err
	}
	t, err := scanThread(s.db.QueryRowContext(ctx, `SELECT `+threadColumns+` FROM chat_threads
		WHERE owner_id = ? AND video_id = ? ORDER BY created_at LIMIT 1`, ownerID, videoID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Service) videoThread(ctx context.Context, ownerID, videoID, title string) (Thread, error) {
	existing, err := s.VideoThread(ctx, ownerID, videoID)
	if err != nil || existing != nil {
		if existing != nil {
			return *existing, nil
		}
		return Thread{}, err
	}
	return s.createThread(ctx, ownerID, &videoID, title)
}

func (s *Service) newLibraryThread(ctx context.Context, ownerID, question string) (Thread, error) {
	title := []rune(strings.Join(strings.Fields(question), " "))
	if len(title) > 60 {
		title = append(title[:57], '…')
	}
	return s.createThread(ctx, ownerID, nil, string(title))
}

func (s *Service) createThread(ctx context.Context, ownerID string, videoID *string, title string) (Thread, error) {
	id := uuid.NewString()
	now := db.FormatTime(s.now())
	if _, err := s.db.ExecContext(ctx, `INSERT INTO chat_threads (id, owner_id, video_id, title, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)`, id, ownerID, videoID, title, now, now); err != nil {
		return Thread{}, err
	}
	return s.getThread(ctx, ownerID, id)
}

// LibraryThreads lists ownerID's conversations about the whole library,
// most recent first.
func (s *Service) LibraryThreads(ctx context.Context, ownerID string) ([]Thread, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+threadColumns+` FROM chat_threads
		WHERE owner_id = ? AND video_id IS NULL ORDER BY updated_at DESC LIMIT 200`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	threads := []Thread{}
	for rows.Next() {
		t, err := scanThread(rows)
		if err != nil {
			return nil, err
		}
		threads = append(threads, t)
	}
	return threads, rows.Err()
}

// RenameThread changes a library conversation's title.
func (s *Service) RenameThread(ctx context.Context, ownerID, id, title string) (Thread, error) {
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > 80 {
		return Thread{}, errors.New("a title of 1 to 80 characters")
	}
	res, err := s.db.ExecContext(ctx, `UPDATE chat_threads SET title = ? WHERE id = ? AND owner_id = ?`, title, id, ownerID)
	if err != nil {
		return Thread{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Thread{}, ErrNotFound
	}
	return s.getThread(ctx, ownerID, id)
}

// DeleteThread deletes a conversation with its messages, stopping an answer
// being written in it.
func (s *Service) DeleteThread(ctx context.Context, ownerID, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM chat_threads WHERE id = ? AND owner_id = ?`, id, ownerID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	s.answering.stopThread(id)
	return nil
}

const messageColumns = `id, role, content, created_at, metadata, status, coalesce(error_message, '')`

// Messages returns a conversation's messages, oldest first. An answer being
// written has the text so far.
func (s *Service) Messages(ctx context.Context, ownerID, threadID string) ([]Message, error) {
	if _, err := s.getThread(ctx, ownerID, threadID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+messageColumns+` FROM chat_messages
		WHERE thread_id = ? AND role IN ('user', 'assistant') ORDER BY created_at, rowid`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []Message{}
	videos := map[string][]int{}
	for rows.Next() {
		m, videoID, err := s.scanMessage(rows)
		if err != nil {
			return nil, err
		}
		if videoID != "" {
			videos[videoID] = append(videos[videoID], len(messages))
		}
		messages = append(messages, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for videoID, at := range videos {
		// A video deleted since is simply no longer named.
		ref, err := s.videoRef(ctx, ownerID, videoID)
		if errors.Is(err, ErrNotFound) || errors.Is(err, ErrNotReady) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, i := range at {
			messages[i].Video = ref
		}
	}
	return messages, nil
}

// message returns one of ownerID's messages.
func (s *Service) message(ctx context.Context, ownerID, id string) (Message, error) {
	m, videoID, err := s.scanMessage(s.db.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM chat_messages
		WHERE id = ? AND owner_id = ?`, id, ownerID))
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	if err != nil {
		return Message{}, err
	}
	if videoID != "" {
		if ref, err := s.videoRef(ctx, ownerID, videoID); err == nil {
			m.Video = ref
		}
	}
	return m, nil
}

func (s *Service) scanMessage(row interface{ Scan(...any) error }) (Message, string, error) {
	var m Message
	var metadata string
	if err := row.Scan(&m.ID, &m.Role, &m.Content, &m.CreatedAt, &metadata, &m.Status, &m.Error); err != nil {
		return Message{}, "", err
	}
	var meta messageMeta
	_ = json.Unmarshal([]byte(metadata), &meta)
	m.Voice = meta.Voice
	if m.Status == StatusStreaming {
		// The saved text lags; the running answer has the latest.
		if text, ok := s.answering.text(m.ID); ok {
			m.Content = text
		}
	}
	return m, meta.VideoID, nil
}

// insertTurn saves a question and its answer (being written).
func (s *Service) insertTurn(ctx context.Context, ownerID, threadID string, asked, reply Message) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, m := range []Message{asked, reply} {
		meta := messageMeta{Voice: m.Voice}
		if m.Video != nil {
			meta.VideoID = m.Video.ID
		}
		metadata, _ := json.Marshal(meta)
		if _, err := tx.ExecContext(ctx, `INSERT INTO chat_messages (id, thread_id, owner_id, role, content, metadata, status, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, m.ID, threadID, ownerID, m.Role, m.Content, string(metadata), m.Status, m.CreatedAt); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE chat_threads SET updated_at = ? WHERE id = ?`, asked.CreatedAt, threadID); err != nil {
		return err
	}
	return tx.Commit()
}
