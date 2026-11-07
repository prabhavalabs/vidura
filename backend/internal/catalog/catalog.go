// Package catalog reads videos, transcripts and processing history for the
// admin portal: lists, details and the dashboard's statistics.
package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// ErrNotFound is returned for an unknown video.
var ErrNotFound = errors.New("not found")

// Store reads the catalog.
type Store struct{ db *sql.DB }

// NewStore returns a Store.
func NewStore(database *sql.DB) *Store { return &Store{db: database} }

// Owner is the user a video belongs to.
type Owner struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

// JobSummary is the latest processing run of a video.
type JobSummary struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	Status     string  `json:"status"`
	Step       *string `json:"step"`
	Progress   int     `json:"progress"`
	DurationMs *int64  `json:"durationMs"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
}

// Video is one row of the videos list.
type Video struct {
	ID               string          `json:"id"`
	YouTubeID        string          `json:"youtubeId"`
	YouTubeURL       string          `json:"youtubeUrl"`
	Title            string          `json:"title"`
	ChannelTitle     *string         `json:"channelTitle"`
	ThumbnailURL     *string         `json:"thumbnailUrl"`
	DurationMs       *int64          `json:"durationMs"`
	SourceLanguage   *string         `json:"sourceLanguage"`
	TargetLanguage   string          `json:"targetLanguage"`
	Status           string          `json:"status"`
	ErrorMessage     *string         `json:"errorMessage"`
	TranscriptSource *string         `json:"transcriptSource"`
	TranscriptEngine *string         `json:"transcriptEngine"`
	QualityScore     *float64        `json:"qualityScore"`
	QualityLabel     *string         `json:"qualityLabel"`
	TranslationModel *string         `json:"translationModel"`
	Owner            Owner           `json:"owner"`
	Segments         int             `json:"segments"`
	Translated       int             `json:"translated"`
	Jobs             int             `json:"jobs"`
	LastJob          *JobSummary     `json:"lastJob"`
	CreatedAt        string          `json:"createdAt"`
	UpdatedAt        string          `json:"updatedAt"`
	SubtitleQuality  json.RawMessage `json:"subtitleQuality,omitempty"`
	Context          json.RawMessage `json:"translationContext,omitempty"`
}

const videoColumns = `
	v.id, v.youtube_video_id, v.youtube_url, v.title, v.channel_title, v.thumbnail_url, v.duration_ms,
	v.source_language, v.target_language, v.status, v.error_message, v.transcript_source, v.transcript_engine,
	json_extract(v.subtitle_quality, '$.score'), json_extract(v.subtitle_quality, '$.label'), v.translation_model,
	u.id, u.email, u.name,
	(SELECT count(*) FROM transcript_segments s WHERE s.video_id = v.id),
	(SELECT count(*) FROM translated_segments t WHERE t.video_id = v.id),
	(SELECT count(*) FROM jobs j WHERE j.video_id = v.id),
	v.created_at, v.updated_at`

func scanVideo(scanner interface{ Scan(...any) error }, extra ...any) (Video, error) {
	var v Video
	dest := []any{
		&v.ID, &v.YouTubeID, &v.YouTubeURL, &v.Title, &v.ChannelTitle, &v.ThumbnailURL, &v.DurationMs,
		&v.SourceLanguage, &v.TargetLanguage, &v.Status, &v.ErrorMessage, &v.TranscriptSource, &v.TranscriptEngine,
		&v.QualityScore, &v.QualityLabel, &v.TranslationModel,
		&v.Owner.ID, &v.Owner.Email, &v.Owner.Name,
		&v.Segments, &v.Translated, &v.Jobs, &v.CreatedAt, &v.UpdatedAt,
	}
	err := scanner.Scan(append(dest, extra...)...)
	return v, err
}

// ListVideos returns every video, newest first, with its latest job.
func (s *Store) ListVideos(ctx context.Context) ([]Video, error) {
	return s.listVideos(ctx, "", nil)
}

func (s *Store) listVideos(ctx context.Context, where string, args []any) ([]Video, error) {
	return s.listVideosPage(ctx, where, args, -1, 0)
}

// listVideosPage lists videos newest first; limit -1 means all of them.
func (s *Store) listVideosPage(ctx context.Context, where string, args []any, limit, offset int) ([]Video, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+videoColumns+` FROM videos v JOIN users u ON u.id = v.owner_id
		`+where+` ORDER BY v.created_at DESC, v.id LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	videos := []Video{}
	for rows.Next() {
		v, err := scanVideo(rows)
		if err != nil {
			return nil, err
		}
		videos = append(videos, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	latest, err := s.latestJobs(ctx)
	if err != nil {
		return nil, err
	}
	for i := range videos {
		if job, ok := latest[videos[i].ID]; ok {
			videos[i].LastJob = &job
		}
	}
	return videos, nil
}

func (s *Store) latestJobs(ctx context.Context) (map[string]JobSummary, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT video_id, `+jobSummaryColumns+` FROM jobs j
		WHERE j.created_at = (SELECT max(created_at) FROM jobs WHERE video_id = j.video_id)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]JobSummary{}
	for rows.Next() {
		var videoID string
		job, err := scanJobSummary(rows, &videoID)
		if err != nil {
			return nil, err
		}
		out[videoID] = job
	}
	return out, rows.Err()
}

const jobSummaryColumns = `j.id, j.kind, j.status, j.current_step, j.progress,
	CASE WHEN j.started_at IS NOT NULL AND j.finished_at IS NOT NULL
		THEN CAST(round((julianday(j.finished_at) - julianday(j.started_at)) * 86400000) AS INTEGER) END,
	j.started_at, j.finished_at`

func scanJobSummary(scanner interface{ Scan(...any) error }, before ...any) (JobSummary, error) {
	var j JobSummary
	err := scanner.Scan(append(before, &j.ID, &j.Kind, &j.Status, &j.Step, &j.Progress, &j.DurationMs, &j.StartedAt, &j.FinishedAt)...)
	return j, err
}

// Segment is one transcript line with its translation.
type Segment struct {
	Index       int     `json:"index"`
	StartMs     int64   `json:"startMs"`
	EndMs       int64   `json:"endMs"`
	Text        string  `json:"text"`
	Translation *string `json:"translation"`
	Model       *string `json:"model"`
	Edited      bool    `json:"edited"`
}

// Job is a processing run with its details.
type Job struct {
	JobSummary
	Attempts     int             `json:"attempts"`
	ErrorMessage *string         `json:"errorMessage"`
	Details      json.RawMessage `json:"details"`
	Legacy       bool            `json:"legacy"`
	CreatedAt    string          `json:"createdAt"`
	RequestedBy  *string         `json:"requestedBy"`
	Video        *JobVideo       `json:"video,omitempty"`
}

// JobVideo identifies the video a job belongs to in job lists.
type JobVideo struct {
	ID               string  `json:"id"`
	Title            string  `json:"title"`
	ThumbnailURL     *string `json:"thumbnailUrl"`
	DurationMs       *int64  `json:"durationMs"`
	TranscriptSource *string `json:"transcriptSource"`
}

// VideoDetail is a video with its transcript and processing history.
type VideoDetail struct {
	Video    Video     `json:"video"`
	Segments []Segment `json:"segments"`
	Jobs     []Job     `json:"jobs"`
}

// GetVideo returns one video with every segment and job.
func (s *Store) GetVideo(ctx context.Context, id string) (VideoDetail, error) {
	var quality, translationContext sql.NullString
	video, err := scanVideo(s.db.QueryRowContext(ctx, `SELECT `+videoColumns+`, v.subtitle_quality, v.translation_context
		FROM videos v JOIN users u ON u.id = v.owner_id WHERE v.id = ?`, id), &quality, &translationContext)
	if errors.Is(err, sql.ErrNoRows) {
		return VideoDetail{}, ErrNotFound
	}
	if err != nil {
		return VideoDetail{}, err
	}
	if quality.Valid {
		video.SubtitleQuality = json.RawMessage(quality.String)
	}
	if translationContext.Valid {
		video.Context = json.RawMessage(translationContext.String)
	}

	detail := VideoDetail{Video: video, Segments: []Segment{}}
	rows, err := s.db.QueryContext(ctx, `SELECT s.segment_index, s.start_ms, s.end_ms, s.text, t.text, t.model, t.edited_by IS NOT NULL
		FROM transcript_segments s
		LEFT JOIN translated_segments t ON t.segment_id = s.id AND t.language_code = ?
		WHERE s.video_id = ? ORDER BY s.segment_index`, video.TargetLanguage, id)
	if err != nil {
		return VideoDetail{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var seg Segment
		var edited sql.NullBool
		if err := rows.Scan(&seg.Index, &seg.StartMs, &seg.EndMs, &seg.Text, &seg.Translation, &seg.Model, &edited); err != nil {
			return VideoDetail{}, err
		}
		seg.Edited = edited.Bool
		detail.Segments = append(detail.Segments, seg)
	}
	if err := rows.Err(); err != nil {
		return VideoDetail{}, err
	}
	detail.Jobs, err = s.listJobs(ctx, `WHERE j.video_id = ?`, []any{id}, 100, false)
	if err != nil {
		return VideoDetail{}, err
	}
	// Jobs are newest first; the latest is the video's current run, as in lists.
	if len(detail.Jobs) > 0 {
		latest := detail.Jobs[0].JobSummary
		detail.Video.LastJob = &latest
	}
	return detail, nil
}

// ListJobs returns processing runs, newest first, optionally only one status.
func (s *Store) ListJobs(ctx context.Context, status string, limit int) ([]Job, error) {
	where, args := "", []any{}
	if status != "" {
		where, args = "WHERE j.status = ?", []any{status}
	}
	return s.listJobs(ctx, where, args, limit, true)
}

func (s *Store) listJobs(ctx context.Context, where string, args []any, limit int, withVideo bool) ([]Job, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+jobSummaryColumns+`, j.attempts, j.error_message, j.details, j.legacy,
			j.created_at, ru.email, v.id, v.title, v.thumbnail_url, v.duration_ms, v.transcript_source
		FROM jobs j JOIN videos v ON v.id = j.video_id LEFT JOIN users ru ON ru.id = j.requested_by
		`+where+` ORDER BY j.created_at DESC LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []Job{}
	for rows.Next() {
		var job Job
		var details string
		var video JobVideo
		err := rows.Scan(&job.ID, &job.Kind, &job.Status, &job.Step, &job.Progress, &job.DurationMs,
			&job.StartedAt, &job.FinishedAt, &job.Attempts, &job.ErrorMessage, &details, &job.Legacy,
			&job.CreatedAt, &job.RequestedBy, &video.ID, &video.Title, &video.ThumbnailURL, &video.DurationMs,
			&video.TranscriptSource)
		if err != nil {
			return nil, err
		}
		job.Details = json.RawMessage(details)
		if withVideo {
			job.Video = &video
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

// --- statistics -----------------------------------------------------------

// Stats feeds the dashboard. Totals are computed here; the timeline is a
// light list of runs the browser buckets by day and hour in local time.
type Stats struct {
	Totals     Totals          `json:"totals"`
	Processing Processing      `json:"processing"`
	Sources    []SourceStats   `json:"sources"`
	Models     []NamedCount    `json:"models"`
	Failures   []NamedCount    `json:"failures"`
	Statuses   []NamedCount    `json:"statuses"`
	Timeline   []TimelineEntry `json:"timeline"`
	Videos     []VideoPoint    `json:"videos"`
}

// Totals are library-wide counts.
type Totals struct {
	Videos             int   `json:"videos"`
	Ready              int   `json:"ready"`
	Failed             int   `json:"failed"`
	InProgress         int   `json:"inProgress"`
	Users              int   `json:"users"`
	Segments           int   `json:"segments"`
	TranslatedSegments int   `json:"translatedSegments"`
	VideoMs            int64 `json:"videoMs"`
	ChatMessages       int   `json:"chatMessages"`
}

// Processing summarizes how long finished runs took.
type Processing struct {
	Runs        int     `json:"runs"`
	Succeeded   int     `json:"succeeded"`
	Failed      int     `json:"failed"`
	SuccessRate float64 `json:"successRate"`
	MedianMs    int64   `json:"medianMs"`
	P90Ms       int64   `json:"p90Ms"`
	AverageMs   int64   `json:"averageMs"`
	// SpeedRatio is minutes of video processed per minute of work, over
	// successful runs of videos with a known length.
	SpeedRatio float64 `json:"speedRatio"`
}

// SourceStats groups videos by how their transcript was obtained.
type SourceStats struct {
	Source      string `json:"source"`
	Engine      string `json:"engine"`
	Videos      int    `json:"videos"`
	MedianRunMs int64  `json:"medianRunMs"`
}

// NamedCount is a label with a count.
type NamedCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// TimelineEntry is one processing run, for charts.
type TimelineEntry struct {
	CreatedAt  string `json:"createdAt"`
	Status     string `json:"status"`
	DurationMs *int64 `json:"durationMs"`
	Source     string `json:"source"`
}

// VideoPoint is one video's length against how long it took, for the
// scatter chart.
type VideoPoint struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	DurationMs int64  `json:"durationMs"`
	RunMs      int64  `json:"runMs"`
	Source     string `json:"source"`
}

// Stats computes the dashboard statistics.
func (s *Store) Stats(ctx context.Context) (Stats, error) {
	var st Stats
	err := s.db.QueryRowContext(ctx, `SELECT
			(SELECT count(*) FROM videos),
			(SELECT count(*) FROM videos WHERE status = 'ready'),
			(SELECT count(*) FROM videos WHERE status = 'failed'),
			(SELECT count(*) FROM videos WHERE status NOT IN ('ready', 'failed')),
			(SELECT count(*) FROM users),
			(SELECT count(*) FROM transcript_segments),
			(SELECT count(*) FROM translated_segments),
			(SELECT coalesce(sum(duration_ms), 0) FROM videos),
			(SELECT count(*) FROM chat_messages)`).Scan(
		&st.Totals.Videos, &st.Totals.Ready, &st.Totals.Failed, &st.Totals.InProgress, &st.Totals.Users,
		&st.Totals.Segments, &st.Totals.TranslatedSegments, &st.Totals.VideoMs, &st.Totals.ChatMessages)
	if err != nil {
		return st, err
	}

	if st.Statuses, err = s.namedCounts(ctx, `SELECT status, count(*) FROM videos GROUP BY status ORDER BY 2 DESC`); err != nil {
		return st, err
	}
	if st.Models, err = s.namedCounts(ctx, `SELECT translation_model, count(*) FROM videos
		WHERE translation_model IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`); err != nil {
		return st, err
	}

	rows, err := s.db.QueryContext(ctx, `SELECT j.created_at, j.status,
			CASE WHEN j.started_at IS NOT NULL AND j.finished_at IS NOT NULL
				THEN CAST(round((julianday(j.finished_at) - julianday(j.started_at)) * 86400000) AS INTEGER) END,
			coalesce(v.transcript_source, 'unknown'), coalesce(v.transcript_engine, ''), v.id, v.title, v.duration_ms,
			coalesce(j.error_message, '')
		FROM jobs j JOIN videos v ON v.id = j.video_id ORDER BY j.created_at`)
	if err != nil {
		return st, err
	}
	defer rows.Close()

	type sourceKey struct{ source, engine string }
	runsBySource := map[sourceKey][]int64{}
	videosBySource := map[sourceKey]map[string]bool{}
	failures := map[string]int{}
	var durations []int64
	var videoMs, runMs int64
	st.Timeline = []TimelineEntry{}
	st.Videos = []VideoPoint{}
	for rows.Next() {
		var entry TimelineEntry
		var engine, videoID, title, errMessage string
		var videoDuration sql.NullInt64
		if err := rows.Scan(&entry.CreatedAt, &entry.Status, &entry.DurationMs, &entry.Source, &engine,
			&videoID, &title, &videoDuration, &errMessage); err != nil {
			return st, err
		}
		st.Timeline = append(st.Timeline, entry)
		key := sourceKey{entry.Source, engine}
		if videosBySource[key] == nil {
			videosBySource[key] = map[string]bool{}
		}
		videosBySource[key][videoID] = true

		switch entry.Status {
		case "succeeded":
			st.Processing.Succeeded++
			if entry.DurationMs != nil && *entry.DurationMs > 0 {
				durations = append(durations, *entry.DurationMs)
				runsBySource[key] = append(runsBySource[key], *entry.DurationMs)
				if videoDuration.Valid && videoDuration.Int64 > 0 {
					videoMs += videoDuration.Int64
					runMs += *entry.DurationMs
					st.Videos = append(st.Videos, VideoPoint{ID: videoID, Title: title,
						DurationMs: videoDuration.Int64, RunMs: *entry.DurationMs, Source: entry.Source})
				}
			}
		case "failed":
			st.Processing.Failed++
			failures[FailureReason(errMessage)]++
		}
	}
	if err := rows.Err(); err != nil {
		return st, err
	}

	st.Processing.Runs = len(st.Timeline)
	if finished := st.Processing.Succeeded + st.Processing.Failed; finished > 0 {
		st.Processing.SuccessRate = float64(st.Processing.Succeeded) / float64(finished)
	}
	st.Processing.MedianMs = percentile(durations, 0.5)
	st.Processing.P90Ms = percentile(durations, 0.9)
	st.Processing.AverageMs = average(durations)
	if runMs > 0 {
		st.Processing.SpeedRatio = float64(videoMs) / float64(runMs)
	}

	st.Sources = []SourceStats{}
	for key, videos := range videosBySource {
		st.Sources = append(st.Sources, SourceStats{Source: key.source, Engine: key.engine, Videos: len(videos),
			MedianRunMs: percentile(runsBySource[key], 0.5)})
	}
	sort.Slice(st.Sources, func(a, b int) bool { return st.Sources[a].Videos > st.Sources[b].Videos })

	st.Failures = []NamedCount{}
	for name, count := range failures {
		st.Failures = append(st.Failures, NamedCount{Name: name, Count: count})
	}
	sort.Slice(st.Failures, func(a, b int) bool {
		if st.Failures[a].Count != st.Failures[b].Count {
			return st.Failures[a].Count > st.Failures[b].Count
		}
		return st.Failures[a].Name < st.Failures[b].Name
	})
	return st, nil
}

func (s *Store) namedCounts(ctx context.Context, query string) ([]NamedCount, error) {
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NamedCount{}
	for rows.Next() {
		var item NamedCount
		if err := rows.Scan(&item.Name, &item.Count); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// FailureReason groups an error message into a short, stable label.
func FailureReason(message string) string {
	m := strings.ToLower(message)
	switch {
	case m == "":
		return "Unknown"
	case strings.Contains(m, "api key") || strings.Contains(m, "401") || strings.Contains(m, "unauthorized"):
		return "AI provider sign-in"
	case strings.Contains(m, "429") || strings.Contains(m, "quota") || strings.Contains(m, "rate limit"):
		return "AI quota or rate limit"
	case strings.Contains(m, "timeout") || strings.Contains(m, "timed out") || strings.Contains(m, "deadline"):
		return "Timed out"
	case strings.Contains(m, "caption") || strings.Contains(m, "subtitle") || strings.Contains(m, "transcript"):
		return "Transcript unavailable"
	case strings.Contains(m, "translat") || strings.Contains(m, "missing segment") || strings.Contains(m, "coverage"):
		return "Incomplete translation"
	case strings.Contains(m, "v2"):
		return "Interrupted by migration"
	default:
		return "Other"
	}
}

func percentile(values []int64, p float64) int64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int64(nil), values...)
	sort.Slice(sorted, func(a, b int) bool { return sorted[a] < sorted[b] })
	index := int(p*float64(len(sorted)-1) + 0.5)
	return sorted[index]
}

func average(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	var sum int64
	for _, v := range values {
		sum += v
	}
	return sum / int64(len(values))
}

// --- actions --------------------------------------------------------------

// Errors for job actions.
var (
	// ErrJobOpen is returned when the video already has a queued or
	// running job; the open job is returned alongside it.
	ErrJobOpen = errors.New("this video already has a run waiting or in progress")
	// ErrNotCancellable is returned for a job that already finished.
	ErrNotCancellable = errors.New("only waiting or running jobs can be cancelled")
	// ErrBadKind is returned for an unknown job kind.
	ErrBadKind = errors.New("unknown job kind")
)

// JobKinds are the runs a superuser can request.
var JobKinds = map[string]bool{"process_video": true, "retranslate": true, "retranscribe": true}

// DeleteVideo removes a video with its transcript, translations, jobs and
// chats, and returns its title for the audit log.
func (s *Store) DeleteVideo(ctx context.Context, id string) (string, error) {
	var title string
	err := s.db.QueryRowContext(ctx, `DELETE FROM videos WHERE id = ? RETURNING title`, id).Scan(&title)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return title, err
}

// RequestJob queues a run for a video. If one is already open it is
// returned with ErrJobOpen.
func (s *Store) RequestJob(ctx context.Context, videoID, kind, requestedBy string) (Job, error) {
	if !JobKinds[kind] {
		return Job{}, ErrBadKind
	}
	var exists int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM videos WHERE id = ?`, videoID).Scan(&exists); err != nil {
		return Job{}, err
	}
	if exists == 0 {
		return Job{}, ErrNotFound
	}
	now := db.FormatTime(time.Now())
	id := uuid.NewString()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Job{}, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO jobs (id, video_id, kind, status, requested_by, details, created_at, updated_at)
		VALUES (?, ?, ?, 'queued', ?, '{}', ?, ?)`, id, videoID, kind, nullable(requestedBy), now, now)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		_ = tx.Rollback()
		open, getErr := s.listJobs(ctx, `WHERE j.video_id = ? AND j.status IN ('queued', 'running')`, []any{videoID}, 1, true)
		if getErr == nil && len(open) == 1 {
			return open[0], ErrJobOpen
		}
		return Job{}, ErrJobOpen
	}
	if err != nil {
		return Job{}, err
	}
	// The new run owns the video's status from here: one status at a time.
	if _, err := tx.ExecContext(ctx, `UPDATE videos SET status = 'queued', error_message = NULL, updated_at = ?
		WHERE id = ?`, now, videoID); err != nil {
		return Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return Job{}, err
	}
	return s.GetJob(ctx, id)
}

// GetJob returns one job with its video.
func (s *Store) GetJob(ctx context.Context, id string) (Job, error) {
	jobs, err := s.listJobs(ctx, `WHERE j.id = ?`, []any{id}, 1, true)
	if err != nil {
		return Job{}, err
	}
	if len(jobs) == 0 {
		return Job{}, ErrNotFound
	}
	return jobs[0], nil
}

// CancelJob stops a waiting or running job. The video goes back to ready
// when every line is still translated, and otherwise shows as failed.
func (s *Store) CancelJob(ctx context.Context, id string) (Job, error) {
	now := db.FormatTime(time.Now())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Job{}, err
	}
	defer tx.Rollback()
	var videoID string
	err = tx.QueryRowContext(ctx, `UPDATE jobs SET status = 'cancelled', cancel_requested = 1,
		finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')
		RETURNING video_id`, now, now, id).Scan(&videoID)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		if _, err := s.GetJob(ctx, id); err != nil {
			return Job{}, err
		}
		return Job{}, ErrNotCancellable
	}
	if err != nil {
		return Job{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE videos SET
			status = CASE WHEN (SELECT count(*) FROM transcript_segments WHERE video_id = videos.id) > 0
				AND (SELECT count(*) FROM transcript_segments WHERE video_id = videos.id) =
					(SELECT count(*) FROM translated_segments WHERE video_id = videos.id AND language_code = videos.target_language)
				THEN 'ready' ELSE 'failed' END,
			error_message = CASE WHEN (SELECT count(*) FROM transcript_segments WHERE video_id = videos.id) > 0
				AND (SELECT count(*) FROM transcript_segments WHERE video_id = videos.id) =
					(SELECT count(*) FROM translated_segments WHERE video_id = videos.id AND language_code = videos.target_language)
				THEN NULL ELSE 'Cancelled before it finished' END,
			updated_at = ?
		WHERE id = ?`, now, videoID); err != nil {
		return Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return Job{}, err
	}
	return s.GetJob(ctx, id)
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
