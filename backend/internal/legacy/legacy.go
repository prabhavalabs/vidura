// Package legacy imports the v1 (Postgres) data, exported as JSON lines by
// scripts/export-legacy.sh, into the SQLite database.
//
// The import runs in one transaction: it either lands completely or not at
// all. It refuses to write over existing videos unless forced, and it never
// imports sessions or OAuth tokens, so everyone signs in again.
package legacy

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// Options control an import.
type Options struct {
	// Force replaces existing content (videos and everything under them,
	// chat, notes, settings, push subscriptions). Users are always merged by
	// email, never deleted.
	Force bool
}

// TableReport counts the rows of one table.
type TableReport struct {
	Table    string
	Source   int
	Imported int
	Skipped  int
}

// Report is the outcome of an import, one entry per table in import order.
type Report []TableReport

// ErrNotEmpty is returned when the database already holds videos and
// Options.Force isn't set.
var ErrNotEmpty = errors.New("the database already has videos; pass --force to replace them")

// Import reads the export in dir and writes it to database.
func Import(ctx context.Context, database *sql.DB, cfg *config.Config, dir string, opts Options) (Report, error) {
	in, err := readExport(dir)
	if err != nil {
		return nil, err
	}

	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var existing int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM videos`).Scan(&existing); err != nil {
		return nil, err
	}
	if existing > 0 {
		if !opts.Force {
			return nil, ErrNotEmpty
		}
		if err := clearContent(ctx, tx); err != nil {
			return nil, err
		}
	}

	im := &importer{ctx: ctx, tx: tx, cfg: cfg, in: in, users: map[string]string{}, now: db.FormatTime(time.Now())}
	steps := []func() (TableReport, error){
		im.importUsers, im.importVideos, im.importSegments, im.importTranslations, im.importJobs,
		im.importChatThreads, im.importChatMessages, im.importNotes, im.importChatSettings,
		im.importTranslationSettings, im.importPush,
	}
	var report Report
	for _, step := range steps {
		table, err := step()
		if err != nil {
			return nil, fmt.Errorf("import %s: %w", table.Table, err)
		}
		report = append(report, table)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return report, nil
}

func clearContent(ctx context.Context, tx *sql.Tx) error {
	for _, table := range []string{
		"push_subscriptions", "translation_settings", "chat_settings", "video_notes",
		"chat_messages", "chat_threads", "jobs", "translated_segments", "transcript_segments", "videos",
	} {
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+table); err != nil {
			return err
		}
	}
	return nil
}

// --- reading the export ---------------------------------------------------

type row = map[string]any

type export struct {
	tables map[string][]row
}

var exportFiles = []string{
	"users", "accounts", "videos", "transcript_segments", "translated_segments", "processing_jobs",
	"chat_threads", "chat_messages", "video_notes", "user_chat_settings", "user_translation_settings",
	"push_subscriptions",
}

func readExport(dir string) (*export, error) {
	out := &export{tables: map[string][]row{}}
	for _, name := range exportFiles {
		rows, err := readJSONL(filepath.Join(dir, name+".jsonl"))
		if err != nil {
			return nil, err
		}
		out.tables[name] = rows
	}
	return out, nil
}

func readJSONL(path string) ([]row, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read export: %w", err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	var rows []row
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			continue
		}
		var r row
		if err := json.Unmarshal([]byte(text), &r); err != nil {
			return nil, fmt.Errorf("%s line %d: %w", filepath.Base(path), line, err)
		}
		rows = append(rows, r)
	}
	return rows, scanner.Err()
}

// --- importer -------------------------------------------------------------

type importer struct {
	ctx context.Context
	tx  *sql.Tx
	cfg *config.Config
	in  *export
	now string
	// users maps v1 user ids to v2 user ids.
	users map[string]string
	// videos and segments hold the ids that were imported, so child rows
	// whose parent was skipped are skipped too.
	videos   map[string]bool
	segments map[string]bool
	threads  map[string]bool
}

func (im *importer) exec(query string, args ...any) error {
	_, err := im.tx.ExecContext(im.ctx, query, args...)
	return err
}

func (im *importer) importUsers() (TableReport, error) {
	report := TableReport{Table: "users", Source: len(im.in.tables["users"])}
	googleSub := map[string]string{}
	for _, account := range im.in.tables["accounts"] {
		if str(account["provider_id"]) == "google" {
			googleSub[str(account["user_id"])] = str(account["account_id"])
		}
	}
	for _, user := range im.in.tables["users"] {
		legacyID := str(user["id"])
		email := config.NormalizeEmail(str(user["email"]))
		if legacyID == "" || email == "" {
			report.Skipped++
			continue
		}
		sub := nullable(googleSub[legacyID])

		var id string
		err := im.tx.QueryRowContext(im.ctx, `SELECT id FROM users WHERE email = ?`, email).Scan(&id)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			role := "member"
			if im.cfg.IsSuperuserEmail(email) {
				role = "superuser"
			}
			id = legacyID
			err = im.exec(`INSERT INTO users (id, email, name, image_url, google_sub, role, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
				id, email, str(user["name"]), nullable(str(user["image"])), sub, role,
				im.time(user["created_at"]), im.time(user["updated_at"]))
		case err == nil:
			// Keep the existing account; fill in what it lacks. A name that is
			// only the email's local part (a development sign-in) counts as
			// missing.
			localPart, _, _ := strings.Cut(email, "@")
			err = im.exec(`UPDATE users SET
					name = CASE WHEN (name = '' OR name = ?) AND ? <> '' THEN ? ELSE name END,
					image_url = COALESCE(image_url, ?),
					google_sub = COALESCE(google_sub, ?)
				WHERE id = ?`, localPart, str(user["name"]), str(user["name"]), nullable(str(user["image"])), sub, id)
		}
		if err != nil {
			return report, err
		}
		if !im.cfg.IsSuperuserEmail(email) {
			if err := im.exec(`INSERT OR IGNORE INTO allowed_emails (email, created_at) VALUES (?, ?)`, email, im.now); err != nil {
				return report, err
			}
		}
		im.users[legacyID] = id
		report.Imported++
	}
	return report, nil
}

func (im *importer) importVideos() (TableReport, error) {
	rows := im.in.tables["videos"]
	report := TableReport{Table: "videos", Source: len(rows)}
	im.videos = map[string]bool{}

	// The translation context (topic, summary, glossary) lived on the jobs;
	// it moves onto the video, taken from the newest job that has one.
	contexts := map[string]any{}
	jobs := append([]row(nil), im.in.tables["processing_jobs"]...)
	sort.SliceStable(jobs, func(a, b int) bool { return str(jobs[a]["created_at"]) < str(jobs[b]["created_at"]) })
	for _, job := range jobs {
		if meta, ok := job["metadata"].(map[string]any); ok && meta["translation_context"] != nil {
			contexts[str(job["video_id"])] = meta["translation_context"]
		}
	}

	for _, video := range rows {
		owner, ok := im.users[str(video["owner_id"])]
		if !ok {
			report.Skipped++
			continue
		}
		meta, _ := video["metadata"].(map[string]any)
		if meta == nil {
			meta = map[string]any{}
		}
		source, engine := transcriptSource(str(meta["transcript_source"]))
		quality := meta["subtitle_quality"]
		model := str(meta["translation_model"])
		for _, key := range []string{"transcript_source", "subtitle_quality", "translation_model"} {
			delete(meta, key)
		}
		status := str(video["status"])
		if status != "ready" && status != "failed" {
			status = "failed" // v1 work in flight can't resume in v2; re-run it
		}
		errMessage := scrub(str(video["error_message"]))
		if status == "failed" && errMessage == "" {
			errMessage = "Processing didn't finish before the move to v2."
		}

		err := im.exec(`INSERT INTO videos (id, owner_id, youtube_video_id, youtube_url, title, channel_title,
				thumbnail_url, duration_ms, source_language, target_language, status, error_message,
				transcript_source, transcript_engine, subtitle_quality, translation_model, translation_context,
				metadata, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			str(video["id"]), owner, str(video["youtube_video_id"]), str(video["youtube_url"]), str(video["title"]),
			nullable(str(video["channel_title"])), nullable(str(video["thumbnail_url"])), num(video["duration_ms"]),
			nullable(language(str(video["source_language"]))), orDefault(language(str(video["target_language"])), "si"),
			status, nullable(errMessage), nullable(source), nullable(engine), jsonOrNil(quality), nullable(model),
			jsonOrNil(contexts[str(video["id"])]), jsonText(meta, "{}"),
			im.time(video["created_at"]), im.time(video["updated_at"]))
		if err != nil {
			return report, err
		}
		im.videos[str(video["id"])] = true
		report.Imported++
	}
	return report, nil
}

func (im *importer) importSegments() (TableReport, error) {
	rows := im.in.tables["transcript_segments"]
	report := TableReport{Table: "transcript_segments", Source: len(rows)}
	im.segments = map[string]bool{}
	stmt, err := im.tx.PrepareContext(im.ctx, `INSERT INTO transcript_segments
		(id, video_id, segment_index, start_ms, end_ms, source_language, text, normalized_text, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return report, err
	}
	defer stmt.Close()
	for _, segment := range rows {
		if !im.videos[str(segment["video_id"])] {
			report.Skipped++
			continue
		}
		if _, err := stmt.ExecContext(im.ctx, str(segment["id"]), str(segment["video_id"]), num(segment["segment_index"]),
			num(segment["start_ms"]), num(segment["end_ms"]), orDefault(language(str(segment["source_language"])), "en"),
			str(segment["text"]), nullable(str(segment["normalized_text"])), im.time(segment["created_at"])); err != nil {
			return report, err
		}
		im.segments[str(segment["id"])] = true
		report.Imported++
	}
	return report, nil
}

func (im *importer) importTranslations() (TableReport, error) {
	rows := im.in.tables["translated_segments"]
	report := TableReport{Table: "translated_segments", Source: len(rows)}
	// Newest version first, so the one kept per (segment, language) is the
	// latest; older versions are counted as skipped.
	sort.SliceStable(rows, func(a, b int) bool { return numInt(rows[a]["version"]) > numInt(rows[b]["version"]) })
	stmt, err := im.tx.PrepareContext(im.ctx, `INSERT INTO translated_segments
		(id, segment_id, video_id, language_code, text, model, quality_flags, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (segment_id, language_code) DO NOTHING`)
	if err != nil {
		return report, err
	}
	defer stmt.Close()
	for _, line := range rows {
		if !im.segments[str(line["segment_id"])] || !im.videos[str(line["video_id"])] {
			report.Skipped++
			continue
		}
		created := im.time(line["created_at"])
		result, err := stmt.ExecContext(im.ctx, str(line["id"]), str(line["segment_id"]), str(line["video_id"]),
			orDefault(language(str(line["language_code"])), "si"), str(line["text"]), str(line["model"]),
			jsonText(line["quality_flags"], "{}"), created, created)
		if err != nil {
			return report, err
		}
		if n, _ := result.RowsAffected(); n == 0 {
			report.Skipped++
			continue
		}
		report.Imported++
	}
	return report, nil
}

func (im *importer) importJobs() (TableReport, error) {
	rows := im.in.tables["processing_jobs"]
	report := TableReport{Table: "jobs", Source: len(rows)}
	for _, job := range rows {
		kind := map[string]string{"process_video": "process_video", "translate_segments": "retranslate"}[str(job["kind"])]
		if kind == "" || !im.videos[str(job["video_id"])] {
			report.Skipped++
			continue
		}
		meta, _ := job["metadata"].(map[string]any)
		if meta == nil {
			meta = map[string]any{}
		}
		details := map[string]any{}
		for key, value := range meta {
			switch key {
			case "translation_context", "current_segment_text":
				// Moved onto the video / transient progress text.
			case "error":
				details[key] = scrub(str(value))
			default:
				details[key] = value
			}
		}
		status := map[string]string{"ready": "succeeded", "failed": "failed"}[str(job["status"])]
		errMessage := scrub(str(job["error_message"]))
		if errMessage == "" {
			errMessage = scrub(str(meta["error"]))
		}
		if status == "" {
			status = "failed"
			errMessage = "Interrupted by the move to v2."
		}
		var requestedBy any
		if id, ok := im.users[str(job["owner_id"])]; ok {
			requestedBy = id
		}
		err := im.exec(`INSERT INTO jobs (id, video_id, kind, status, current_step, progress, requested_by, attempts,
				error_message, details, legacy, created_at, started_at, finished_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
			str(job["id"]), str(job["video_id"]), kind, status, nullable(str(meta["stage"])), clamp(numInt(job["progress"])),
			requestedBy, numInt(job["attempts"]), nullable(errMessage), jsonText(details, "{}"),
			im.time(job["created_at"]), im.optionalTime(job["started_at"]), im.optionalTime(job["finished_at"]),
			im.time(job["updated_at"]))
		if err != nil {
			return report, err
		}
		report.Imported++
	}
	return report, nil
}

func (im *importer) importChatThreads() (TableReport, error) {
	rows := im.in.tables["chat_threads"]
	report := TableReport{Table: "chat_threads", Source: len(rows)}
	im.threads = map[string]bool{}
	for _, thread := range rows {
		owner, ok := im.users[str(thread["owner_id"])]
		videoID := str(thread["video_id"])
		if !ok || (videoID != "" && !im.videos[videoID]) {
			report.Skipped++
			continue
		}
		if err := im.exec(`INSERT INTO chat_threads (id, owner_id, video_id, title, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)`, str(thread["id"]), owner, nullable(videoID), nullable(str(thread["title"])),
			im.time(thread["created_at"]), im.time(thread["updated_at"])); err != nil {
			return report, err
		}
		im.threads[str(thread["id"])] = true
		report.Imported++
	}
	return report, nil
}

func (im *importer) importChatMessages() (TableReport, error) {
	rows := im.in.tables["chat_messages"]
	report := TableReport{Table: "chat_messages", Source: len(rows)}
	for _, message := range rows {
		owner, ok := im.users[str(message["owner_id"])]
		if !ok || !im.threads[str(message["thread_id"])] {
			report.Skipped++
			continue
		}
		if err := im.exec(`INSERT INTO chat_messages (id, thread_id, owner_id, role, content, cited_segment_ids, metadata, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, str(message["id"]), str(message["thread_id"]), owner, str(message["role"]),
			str(message["content"]), jsonText(message["cited_segment_ids"], "[]"), jsonText(message["metadata"], "{}"),
			im.time(message["created_at"])); err != nil {
			return report, err
		}
		report.Imported++
	}
	return report, nil
}

func (im *importer) importNotes() (TableReport, error) {
	rows := im.in.tables["video_notes"]
	report := TableReport{Table: "video_notes", Source: len(rows)}
	for _, note := range rows {
		owner, ok := im.users[str(note["owner_id"])]
		if !ok || !im.videos[str(note["video_id"])] {
			report.Skipped++
			continue
		}
		if err := im.exec(`INSERT INTO video_notes (id, owner_id, video_id, timestamp_ms, content, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, str(note["id"]), owner, str(note["video_id"]), numInt(note["timestamp_ms"]),
			str(note["content"]), im.time(note["created_at"]), im.time(note["updated_at"])); err != nil {
			return report, err
		}
		report.Imported++
	}
	return report, nil
}

func (im *importer) importChatSettings() (TableReport, error) {
	rows := im.in.tables["user_chat_settings"]
	report := TableReport{Table: "chat_settings", Source: len(rows)}
	for _, s := range rows {
		owner, ok := im.users[str(s["owner_id"])]
		if !ok {
			report.Skipped++
			continue
		}
		if err := im.exec(`INSERT OR REPLACE INTO chat_settings (owner_id, response_language, answer_style,
				custom_instructions, memory_depth, retrieval_depth, creativity, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, owner, str(s["response_language"]), str(s["answer_style"]),
			str(s["custom_instructions"]), str(s["memory_depth"]), str(s["retrieval_depth"]), str(s["creativity"]),
			im.time(s["created_at"]), im.time(s["updated_at"])); err != nil {
			return report, err
		}
		report.Imported++
	}
	return report, nil
}

func (im *importer) importTranslationSettings() (TableReport, error) {
	rows := im.in.tables["user_translation_settings"]
	report := TableReport{Table: "translation_settings", Source: len(rows)}
	for _, s := range rows {
		owner, ok := im.users[str(s["owner_id"])]
		if !ok {
			report.Skipped++
			continue
		}
		if err := im.exec(`INSERT OR REPLACE INTO translation_settings (owner_id, target_language, system_prompt, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)`, owner, orDefault(language(str(s["target_language"])), "si"), str(s["system_prompt"]),
			im.time(s["created_at"]), im.time(s["updated_at"])); err != nil {
			return report, err
		}
		report.Imported++
	}
	return report, nil
}

func (im *importer) importPush() (TableReport, error) {
	rows := im.in.tables["push_subscriptions"]
	report := TableReport{Table: "push_subscriptions", Source: len(rows)}
	for _, s := range rows {
		owner, ok := im.users[str(s["owner_id"])]
		if !ok {
			report.Skipped++
			continue
		}
		if err := im.exec(`INSERT OR IGNORE INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`, str(s["id"]), owner, str(s["endpoint"]), str(s["p256dh"]), str(s["auth"]),
			im.time(s["created_at"])); err != nil {
			return report, err
		}
		report.Imported++
	}
	return report, nil
}

// --- value helpers --------------------------------------------------------

func str(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func num(value any) any {
	if f, ok := value.(float64); ok {
		return int64(f)
	}
	return nil
}

func numInt(value any) int64 {
	if f, ok := value.(float64); ok {
		return int64(f)
	}
	return 0
}

func clamp(progress int64) int64 { return max(0, min(100, progress)) }

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func jsonText(value any, empty string) string {
	if value == nil {
		return empty
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return empty
	}
	return string(encoded)
}

func jsonOrNil(value any) any {
	if value == nil {
		return nil
	}
	return jsonText(value, "null")
}

// time converts a Postgres timestamp to the database's UTC layout. A missing
// or unreadable value becomes the import time, so NOT NULL columns hold.
func (im *importer) time(value any) string {
	if formatted := im.optionalTime(value); formatted != nil {
		return formatted.(string)
	}
	return im.now
}

func (im *importer) optionalTime(value any) any {
	text := str(value)
	if text == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return nil
	}
	return db.FormatTime(parsed)
}

// language normalizes v1 language codes and names to BCP-47.
func language(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		return ""
	case "si", "si-lk", "sinhala", "sinhalese":
		return "si"
	case "en", "en-us", "en-gb", "english":
		return "en"
	default:
		return value
	}
}

// transcriptSource maps v1's transcript_source to v2's source and engine.
func transcriptSource(value string) (source, engine string) {
	switch value {
	case "":
		return "", ""
	case "ytdlp", "youtube", "youtube-transcript", "captions":
		return "captions", "yt-dlp"
	case "gemini":
		return "asr", "gemini"
	case "upload", "uploaded", "manual":
		return "uploaded", ""
	default:
		return "", value
	}
}

var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`sk-[A-Za-z0-9_*\-]{6,}`),
	regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._\-]+`),
	regexp.MustCompile(`AIza[0-9A-Za-z_\-]{20,}`),
}

// scrub removes API keys that upstream error messages echoed back.
func scrub(message string) string {
	for _, pattern := range secretPatterns {
		message = pattern.ReplaceAllString(message, "[redacted]")
	}
	return message
}
