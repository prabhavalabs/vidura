// Package worker runs queued processing jobs: it claims one job at a time per
// runner, takes the video through captions (or speech recognition on the
// paired Mac), the glossary, translation and a final coverage check, and
// records the step and progress as it goes so the portals can show it live.
//
// The queue is the jobs table. A claim is one atomic UPDATE, finished work is
// stored as it happens (transcript lines, each translation window), and a run
// interrupted by a restart is queued again and resumes where it stopped.
package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/pipeline"
	"github.com/prabhavalabs/vidura/backend/internal/settings"
)

// Steps a job reports in jobs.current_step.
const (
	StepCaptions   = "captions"
	StepTranscribe = "transcribe"
	StepContext    = "context"
	StepTranslate  = "translate"
	StepVerify     = "verify"
)

var errSpeechRequested = errors.New("speech recognition requested")

// Transcriber turns a video's audio into English segments, on the Mac.
type Transcriber interface {
	// Transcribe returns the segments and the engine that produced them.
	// progress reports 0-100 and a short note while it works.
	Transcribe(ctx context.Context, youtubeID, engine string, progress func(percent int, note string)) ([]pipeline.Segment, string, error)
}

// Captions downloads a video's caption track.
type Captions interface {
	FetchCaptions(ctx context.Context, youtubeID string) (pipeline.Captions, error)
}

// Worker runs jobs. Create it with New and start it with Run.
type Worker struct {
	db          *sql.DB
	model       pipeline.Model
	settings    *settings.Store
	captions    Captions
	transcriber Transcriber
	runners     int
	poll        time.Duration
	wake        chan struct{}
	finished    func(videoID string, ok bool)
}

// Options configure a Worker. Model and Transcriber may be nil; jobs that need
// them then fail with a clear message.
type Options struct {
	Model       pipeline.Model
	Captions    Captions
	Transcriber Transcriber
	// Runners is how many jobs run at once (default 2).
	Runners int
	// Poll is the fallback interval for new jobs (default 5 s).
	Poll time.Duration
	// Finished is called, in its own goroutine, after a run succeeds or
	// fails (not when it's cancelled): it notifies the video's owner.
	Finished func(videoID string, ok bool)
}

// New returns a Worker.
func New(database *sql.DB, store *settings.Store, opts Options) *Worker {
	w := &Worker{
		db: database, settings: store, model: opts.Model, captions: opts.Captions,
		transcriber: opts.Transcriber, runners: opts.Runners, poll: opts.Poll,
		wake: make(chan struct{}, 1), finished: opts.Finished,
	}
	if w.runners <= 0 {
		w.runners = 2
	}
	if w.poll <= 0 {
		w.poll = 5 * time.Second
	}
	if w.captions == nil {
		w.captions = pipeline.YouTube{}
	}
	return w
}

// Notify wakes the worker after a job is queued.
func (w *Worker) Notify() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// Run processes jobs until ctx ends, then waits for running jobs to stop.
func (w *Worker) Run(ctx context.Context) {
	if err := w.recover(ctx); err != nil {
		slog.Error("worker: requeue interrupted jobs", "err", err)
	}
	var wg sync.WaitGroup
	for i := 0; i < w.runners; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.loop(ctx)
		}()
	}
	wg.Wait()
}

// recover puts jobs that were running when the server stopped back in the
// queue; their finished work is kept and they resume.
func (w *Worker) recover(ctx context.Context) error {
	now := db.FormatTime(time.Now())
	res, err := w.db.ExecContext(ctx, `UPDATE jobs SET status = 'queued', updated_at = ?
		WHERE status = 'running' AND legacy = 0`, now)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		slog.Info("worker: requeued interrupted jobs", "count", n)
	}
	return nil
}

func (w *Worker) loop(ctx context.Context) {
	ticker := time.NewTicker(w.poll)
	defer ticker.Stop()
	for {
		for {
			job, ok, err := w.claim(ctx)
			if err != nil {
				if ctx.Err() == nil {
					slog.Error("worker: claim", "err", err)
				}
				break
			}
			if !ok {
				break
			}
			w.Notify() // let another runner look for more work
			w.execute(ctx, job)
			if ctx.Err() != nil {
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-w.wake:
		case <-ticker.C:
		}
	}
}

type job struct {
	ID       string
	VideoID  string
	Kind     string
	Attempts int
}

func (w *Worker) claim(ctx context.Context) (job, bool, error) {
	now := db.FormatTime(time.Now())
	var j job
	err := w.db.QueryRowContext(ctx, `UPDATE jobs SET status = 'running', attempts = attempts + 1,
			started_at = ?, finished_at = NULL, error_message = NULL, progress = 0, updated_at = ?
		WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND legacy = 0 AND cancel_requested = 0
			ORDER BY created_at LIMIT 1)
		RETURNING id, video_id, kind, attempts`, now, now).Scan(&j.ID, &j.VideoID, &j.Kind, &j.Attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return job{}, false, nil
	}
	if err != nil {
		return job{}, false, err
	}
	return j, true, nil
}

// execute runs one claimed job to its end. A cancel from the portal stops it
// within a couple of seconds.
func (w *Worker) execute(parent context.Context, j job) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	go w.watchCancel(ctx, cancel, j.ID)

	started := time.Now()
	slog.Info("job started", "job", j.ID, "video", j.VideoID, "kind", j.Kind, "attempt", j.Attempts)
	r := &run{w: w, job: j}
	err := r.process(ctx)
	switch {
	case err == nil:
		slog.Info("job finished", "job", j.ID, "took", time.Since(started).Round(time.Second).String())
	case parent.Err() != nil:
		// Shutting down: leave it running so the next start requeues it.
		slog.Info("job interrupted by shutdown", "job", j.ID)
	case ctx.Err() != nil:
		slog.Info("job cancelled", "job", j.ID)
	default:
		slog.Warn("job failed", "job", j.ID, "err", err)
		r.fail(err)
	}
}

func (w *Worker) watchCancel(ctx context.Context, cancel context.CancelFunc, id string) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var status string
			if err := w.db.QueryRowContext(ctx, `SELECT status FROM jobs WHERE id = ?`, id).Scan(&status); err != nil {
				if errors.Is(err, sql.ErrNoRows) { // the video was deleted
					cancel()
				}
				continue
			}
			if status != "running" {
				cancel()
				return
			}
		}
	}
}

// --- one run ----------------------------------------------------------------

type video struct {
	OwnerID    string
	YouTubeID  string
	Title      string
	Channel    string
	DurationMs int64
	Context    *pipeline.Context
}

type run struct {
	w   *Worker
	job job

	mu      sync.Mutex
	details map[string]any
}

func (r *run) process(ctx context.Context) error {
	cfg, err := r.w.settings.Get(ctx)
	if err != nil {
		return err
	}
	v, err := r.loadVideo(ctx)
	if err != nil {
		return err
	}

	switch r.job.Kind {
	case "retranscribe":
		if _, err := r.w.db.ExecContext(ctx, `DELETE FROM transcript_segments WHERE video_id = ?`, r.job.VideoID); err != nil {
			return err
		}
		if _, err := r.w.db.ExecContext(ctx, `UPDATE videos SET translation_context = NULL WHERE id = ?`, r.job.VideoID); err != nil {
			return err
		}
		v.Context = nil
	case "retranslate":
		if _, err := r.w.db.ExecContext(ctx, `DELETE FROM translated_segments WHERE video_id = ? AND edited_by IS NULL`, r.job.VideoID); err != nil {
			return err
		}
		if _, err := r.w.db.ExecContext(ctx, `UPDATE videos SET translation_context = NULL WHERE id = ?`, r.job.VideoID); err != nil {
			return err
		}
		v.Context = nil
	}

	segments, err := r.storedSegments(ctx)
	if err != nil {
		return err
	}
	if len(segments) == 0 {
		segments, err = r.transcript(ctx, cfg, &v)
		if err != nil {
			return err
		}
	}
	total := len(segments)

	done, err := r.storedTranslations(ctx)
	if err != nil {
		return err
	}
	if len(done) < total {
		if r.w.model == nil {
			return errors.New("ChatGPT isn't available on this server")
		}
		if !v.Context.Valid() {
			r.step(ctx, StepContext, "translating", 15, map[string]any{
				"stage": "Reading the whole video to build its glossary", "total_segments": total,
				"translated_segments": len(done), "translator": task(cfg, "summary").Model,
			})
			built, err := pipeline.BuildContext(ctx, r.w.model, task(cfg, "summary"), r.info(ctx, v), segments)
			if err != nil {
				return fmt.Errorf("glossary: %w", err)
			}
			v.Context = &built
			raw, _ := json.Marshal(built)
			if _, err := r.w.db.ExecContext(ctx, `UPDATE videos SET translation_context = ?, updated_at = ? WHERE id = ?`,
				string(raw), db.FormatTime(time.Now()), r.job.VideoID); err != nil {
				return err
			}
		}

		tr := task(cfg, "translate")
		r.step(ctx, StepTranslate, "translating", translateProgress(len(done), total), map[string]any{
			"stage": "Translating", "total_segments": total, "translated_segments": len(done), "translator": tr.Model,
		})
		ids, err := r.segmentIDs(ctx)
		if err != nil {
			return err
		}
		_, err = pipeline.Translate(ctx, r.w.model, tr, pipeline.TranslateInput{
			Segments: segments, Video: r.info(ctx, v), Context: v.Context, Done: done,
			Started: func(first, last, finished, total int) {
				r.step(ctx, StepTranslate, "translating", translateProgress(finished, total), map[string]any{
					"stage":               fmt.Sprintf("Translating lines %d–%d", first+1, last+1),
					"translated_segments": finished, "total_segments": total,
				})
			},
			Saved: func(lines []pipeline.Line, finished, total int) error {
				if err := r.saveTranslations(ctx, ids, lines, tr.Model); err != nil {
					return err
				}
				r.step(ctx, StepTranslate, "translating", translateProgress(finished, total), map[string]any{
					"translated_segments": finished, "total_segments": total,
				})
				return nil
			},
		})
		if err != nil {
			return fmt.Errorf("translation: %w", err)
		}
		if _, err := r.w.db.ExecContext(ctx, `UPDATE videos SET translation_model = ? WHERE id = ?`, tr.Model, r.job.VideoID); err != nil {
			return err
		}
	}

	// The database is the final word: every line must have a stored,
	// non-empty translation before the video is ready.
	r.step(ctx, StepVerify, "translating", 97, map[string]any{"stage": "Checking every line is translated"})
	final, err := r.storedTranslations(ctx)
	if err != nil {
		return err
	}
	if len(final) < total {
		return fmt.Errorf("only %d of %d lines are translated", len(final), total)
	}
	return r.succeed(ctx, total)
}

// transcript gets the English transcript: YouTube's captions first, then the
// Mac's speech recognition when the video has none.
func (r *run) transcript(ctx context.Context, cfg settings.Settings, v *video) ([]pipeline.Segment, error) {
	// "retranscribe" skips the captions and always uses the Mac.
	forceASR := r.job.Kind == "retranscribe"
	var caps pipeline.Captions
	var err error
	if forceASR {
		err = errSpeechRequested
	} else {
		r.step(ctx, StepCaptions, "fetching_transcript", 3, map[string]any{"stage": "Downloading YouTube captions"})
		caps, err = r.w.captions.FetchCaptions(ctx, v.YouTubeID)
		if err := r.saveMetadata(ctx, caps.Metadata, v); err != nil {
			return nil, err
		}
	}
	source, engine := pipeline.SourceCaptions, "yt-dlp"
	var cues []pipeline.Segment
	switch {
	case err == nil:
		cues = caps.Segments
		if caps.Track != "" {
			engine = "yt-dlp · " + caps.Track
		}
	case errors.Is(err, pipeline.ErrNoCaptions), errors.Is(err, errSpeechRequested):
		if !cfg.ASRFallback && !forceASR {
			return nil, errors.New("the video has no English captions and Mac transcription is turned off in Settings")
		}
		if r.w.transcriber == nil {
			return nil, errors.New("the video has no English captions and no Mac transcriber is set up")
		}
		stage := "No captions; sending to the Mac for speech recognition"
		if forceASR {
			stage = "Sending to the Mac for speech recognition"
		}
		r.step(ctx, StepTranscribe, "transcribing", 3, map[string]any{"stage": stage, "engine": cfg.ASREngine})
		cues, engine, err = r.w.transcriber.Transcribe(ctx, v.YouTubeID, cfg.ASREngine, func(percent int, note string) {
			r.step(ctx, StepTranscribe, "transcribing", 3+percent*12/100, map[string]any{"stage": note, "transcribe_percent": percent})
		})
		if err != nil {
			return nil, fmt.Errorf("speech recognition: %w", err)
		}
		source = pipeline.SourceASR
	default:
		return nil, fmt.Errorf("captions: %w", err)
	}

	segments := pipeline.Consolidate(cues)
	if len(segments) == 0 {
		return nil, errors.New("the transcript was empty")
	}
	if err := r.saveTranscript(ctx, segments, source, engine, v.DurationMs); err != nil {
		return nil, err
	}
	r.step(ctx, StepCaptions, "fetching_transcript", 15, map[string]any{
		"stage": "Transcript saved", "total_segments": len(segments), "transcript_source": source,
	})
	return segments, nil
}

func task(cfg settings.Settings, name string) pipeline.Task {
	t := cfg.AI[name]
	if t.Model == "" {
		t = settings.Defaults.AI[name]
	}
	return pipeline.Task{Model: t.Model, Effort: t.Effort}
}

// translateProgress maps translated lines onto 25-95 %.
func translateProgress(done, total int) int {
	if total <= 0 {
		return 25
	}
	return min(95, 25+done*70/total)
}

func (r *run) info(ctx context.Context, v video) pipeline.VideoInfo {
	var guidance sql.NullString
	_ = r.w.db.QueryRowContext(ctx, `SELECT system_prompt FROM translation_settings WHERE owner_id = ?`, v.OwnerID).Scan(&guidance)
	return pipeline.VideoInfo{Title: v.Title, ChannelTitle: v.Channel, Guidance: guidance.String}
}

// --- database ---------------------------------------------------------------

func (r *run) loadVideo(ctx context.Context) (video, error) {
	var v video
	var channel, contextRaw sql.NullString
	var duration sql.NullInt64
	err := r.w.db.QueryRowContext(ctx, `SELECT owner_id, youtube_video_id, title, channel_title, duration_ms, translation_context
		FROM videos WHERE id = ?`, r.job.VideoID).Scan(&v.OwnerID, &v.YouTubeID, &v.Title, &channel, &duration, &contextRaw)
	if err != nil {
		return v, fmt.Errorf("load video: %w", err)
	}
	v.Channel, v.DurationMs = channel.String, duration.Int64
	if contextRaw.Valid {
		var c pipeline.Context
		if json.Unmarshal([]byte(contextRaw.String), &c) == nil && c.Valid() {
			v.Context = &c
		}
	}
	return v, nil
}

func (r *run) saveMetadata(ctx context.Context, m pipeline.Metadata, v *video) error {
	if m.Title != "" {
		v.Title = m.Title
	}
	if m.ChannelTitle != "" {
		v.Channel = m.ChannelTitle
	}
	if m.DurationMs > 0 {
		v.DurationMs = m.DurationMs
	}
	_, err := r.w.db.ExecContext(ctx, `UPDATE videos SET
			title = coalesce(nullif(?, ''), title),
			channel_title = coalesce(nullif(?, ''), channel_title),
			duration_ms = coalesce(nullif(?, 0), duration_ms),
			thumbnail_url = coalesce(nullif(?, ''), thumbnail_url),
			source_language = coalesce(source_language, 'en'),
			updated_at = ?
		WHERE id = ?`, m.Title, m.ChannelTitle, m.DurationMs, m.ThumbnailURL, db.FormatTime(time.Now()), r.job.VideoID)
	return err
}

func (r *run) saveTranscript(ctx context.Context, segments []pipeline.Segment, source, engine string, durationMs int64) error {
	tx, err := r.w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := db.FormatTime(time.Now())
	if _, err := tx.ExecContext(ctx, `DELETE FROM transcript_segments WHERE video_id = ?`, r.job.VideoID); err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO transcript_segments
		(id, video_id, segment_index, start_ms, end_ms, source_language, text, normalized_text, created_at)
		VALUES (?, ?, ?, ?, ?, 'en', ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, s := range segments {
		if _, err := stmt.ExecContext(ctx, uuid.NewString(), r.job.VideoID, s.Index, s.StartMs, s.EndMs,
			s.Text, strings.ToLower(s.Text), now); err != nil {
			return err
		}
	}
	quality, _ := json.Marshal(pipeline.AssessQuality(segments, durationMs, source))
	if _, err := tx.ExecContext(ctx, `UPDATE videos SET transcript_source = ?, transcript_engine = ?,
		subtitle_quality = ?, updated_at = ? WHERE id = ?`, source, engine, string(quality), now, r.job.VideoID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *run) storedSegments(ctx context.Context) ([]pipeline.Segment, error) {
	rows, err := r.w.db.QueryContext(ctx, `SELECT segment_index, start_ms, end_ms, text FROM transcript_segments
		WHERE video_id = ? ORDER BY segment_index`, r.job.VideoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []pipeline.Segment{}
	for rows.Next() {
		var s pipeline.Segment
		if err := rows.Scan(&s.Index, &s.StartMs, &s.EndMs, &s.Text); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *run) segmentIDs(ctx context.Context) (map[int]string, error) {
	rows, err := r.w.db.QueryContext(ctx, `SELECT segment_index, id FROM transcript_segments WHERE video_id = ?`, r.job.VideoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]string{}
	for rows.Next() {
		var index int
		var id string
		if err := rows.Scan(&index, &id); err != nil {
			return nil, err
		}
		out[index] = id
	}
	return out, rows.Err()
}

func (r *run) storedTranslations(ctx context.Context) (map[int]string, error) {
	rows, err := r.w.db.QueryContext(ctx, `SELECT s.segment_index, t.text FROM translated_segments t
		JOIN transcript_segments s ON s.id = t.segment_id
		WHERE t.video_id = ? AND t.language_code = 'si'`, r.job.VideoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]string{}
	for rows.Next() {
		var index int
		var text string
		if err := rows.Scan(&index, &text); err != nil {
			return nil, err
		}
		if strings.TrimSpace(text) != "" {
			out[index] = strings.TrimSpace(text)
		}
	}
	return out, rows.Err()
}

func (r *run) saveTranslations(ctx context.Context, ids map[int]string, lines []pipeline.Line, model string) error {
	tx, err := r.w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := db.FormatTime(time.Now())
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO translated_segments
		(id, segment_id, video_id, language_code, text, model, created_at, updated_at)
		VALUES (?, ?, ?, 'si', ?, ?, ?, ?)
		ON CONFLICT (segment_id, language_code) DO UPDATE SET text = excluded.text, model = excluded.model,
			updated_at = excluded.updated_at WHERE translated_segments.edited_by IS NULL`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, line := range lines {
		id, ok := ids[line.Index]
		if !ok {
			continue
		}
		if _, err := stmt.ExecContext(ctx, uuid.NewString(), id, r.job.VideoID, line.Text, model, now, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// step records the current step, progress and details, and mirrors the
// stage onto the video. Writes only land while the job is still running, so
// a cancelled job is never brought back.
func (r *run) step(ctx context.Context, step, videoStatus string, progress int, details map[string]any) {
	r.mu.Lock()
	if r.details == nil {
		r.details = map[string]any{}
	}
	for k, v := range details {
		r.details[k] = v
	}
	r.details["step"] = step
	raw, _ := json.Marshal(r.details)
	r.mu.Unlock()

	now := db.FormatTime(time.Now())
	if _, err := r.w.db.ExecContext(ctx, `UPDATE jobs SET current_step = ?, progress = max(progress, ?),
		details = json_patch(details, ?), updated_at = ? WHERE id = ? AND status = 'running'`,
		step, min(100, max(0, progress)), string(raw), now, r.job.ID); err != nil && ctx.Err() == nil {
		slog.Warn("worker: record progress", "job", r.job.ID, "err", err)
	}
	if _, err := r.w.db.ExecContext(ctx, `UPDATE videos SET status = ?, error_message = NULL, updated_at = ?
		WHERE id = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'running')`,
		videoStatus, now, r.job.VideoID, r.job.ID); err != nil && ctx.Err() == nil {
		slog.Warn("worker: record video status", "video", r.job.VideoID, "err", err)
	}
}

func (r *run) succeed(ctx context.Context, total int) error {
	tx, err := r.w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := db.FormatTime(time.Now())
	details, _ := json.Marshal(map[string]any{
		"stage": "Ready", "total_segments": total, "translated_segments": total, "coverage": 100,
	})
	res, err := tx.ExecContext(ctx, `UPDATE jobs SET status = 'succeeded', progress = 100, current_step = 'ready',
		details = json_patch(details, ?), finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
		string(details), now, now, r.job.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return context.Canceled
	}
	if _, err := tx.ExecContext(ctx, `UPDATE videos SET status = 'ready', error_message = NULL, updated_at = ? WHERE id = ?`,
		now, r.job.VideoID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	r.w.announce(r.job.VideoID, true)
	return nil
}

// announce runs the Finished callback without holding up the runner.
func (w *Worker) announce(videoID string, ok bool) {
	if w.finished != nil {
		go w.finished(videoID, ok)
	}
}

// fail records the error on the job and the video. It uses its own context:
// the run's may already be over.
func (r *run) fail(cause error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	message := cause.Error()
	switch {
	case errors.Is(cause, chatgpt.ErrAuth):
		message = chatgpt.ErrAuth.Error()
	case errors.Is(cause, chatgpt.ErrQuota):
		message = chatgpt.ErrQuota.Error()
	}
	if len(message) > 500 {
		message = message[:500]
	}
	now := db.FormatTime(time.Now())
	tx, err := r.w.db.BeginTx(ctx, nil)
	if err != nil {
		slog.Error("worker: record failure", "job", r.job.ID, "err", err)
		return
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE jobs SET status = 'failed', error_message = ?, finished_at = ?, updated_at = ?
		WHERE id = ? AND status = 'running'`, message, now, now, r.job.ID)
	if err != nil {
		slog.Error("worker: record failure", "job", r.job.ID, "err", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return
	}
	if _, err := tx.ExecContext(ctx, `UPDATE videos SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
		message, now, r.job.VideoID); err != nil {
		slog.Error("worker: record failure", "job", r.job.ID, "err", err)
		return
	}
	if err := tx.Commit(); err != nil {
		slog.Error("worker: record failure", "job", r.job.ID, "err", err)
		return
	}
	r.w.announce(r.job.VideoID, false)
}
