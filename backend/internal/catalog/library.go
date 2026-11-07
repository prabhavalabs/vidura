package catalog

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// A user's own library, for the client portal. Every function here is
// scoped to one owner: a video that belongs to someone else is ErrNotFound.

// ErrBadURL is returned for a link that isn't a YouTube video.
var ErrBadURL = errors.New("that isn't a YouTube video link")

var youtubeID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// ParseYouTubeID returns the video ID in a YouTube link (watch, youtu.be,
// shorts, embed, live, mobile and no-cookie links) or a bare 11-character ID.
func ParseYouTubeID(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if youtubeID.MatchString(raw) {
		return raw, nil
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return "", ErrBadURL
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	var id string
	switch host {
	case "youtu.be":
		id = firstSegment(u.Path)
	case "youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com":
		if u.Path == "/watch" {
			id = u.Query().Get("v")
			break
		}
		for _, prefix := range []string{"/shorts/", "/embed/", "/live/", "/v/"} {
			if strings.HasPrefix(u.Path, prefix) {
				id = firstSegment(strings.TrimPrefix(u.Path, prefix))
			}
		}
	}
	if !youtubeID.MatchString(id) {
		return "", ErrBadURL
	}
	return id, nil
}

func firstSegment(path string) string {
	segment, _, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	return segment
}

// LibraryQuery picks a page of a user's library.
type LibraryQuery struct {
	// Search matches the title or channel, case-insensitively.
	Search string
	// Filter is "", "ready", "processing" or "failed".
	Filter string
	Page   int // from 1
	Size   int // videos per page
}

// LibraryFilters are the filters a LibraryQuery accepts.
var LibraryFilters = map[string]bool{"": true, "ready": true, "processing": true, "failed": true}

// LibraryPage is one page of a library, with counts for each filter under
// the same search.
type LibraryPage struct {
	Videos []Video        `json:"videos"`
	Page   int            `json:"page"`
	Size   int            `json:"size"`
	Total  int            `json:"total"`
	Counts map[string]int `json:"counts"`
}

// A video is processing while it has an open run or hasn't finished;
// otherwise it is ready or failed. Each video is in exactly one of these.
const openRun = `EXISTS (SELECT 1 FROM jobs o WHERE o.video_id = v.id AND o.status IN ('queued', 'running'))`

var filterSQL = map[string]string{
	"ready":      `v.status = 'ready' AND NOT ` + openRun,
	"failed":     `v.status = 'failed' AND NOT ` + openRun,
	"processing": `(v.status NOT IN ('ready', 'failed') OR ` + openRun + `)`,
}

// ListOwnVideos returns a page of ownerID's videos, newest first.
func (s *Store) ListOwnVideos(ctx context.Context, ownerID string, q LibraryQuery) (LibraryPage, error) {
	if q.Size <= 0 || q.Size > 100 {
		q.Size = 24
	}
	if q.Page < 1 {
		q.Page = 1
	}
	where := "WHERE v.owner_id = ?"
	args := []any{ownerID}
	if term := strings.TrimSpace(q.Search); term != "" {
		like := "%" + escapeLike(strings.ToLower(term)) + "%"
		where += ` AND (lower(v.title) LIKE ? ESCAPE '\' OR lower(coalesce(v.channel_title, '')) LIKE ? ESCAPE '\')`
		args = append(args, like, like)
	}

	page := LibraryPage{Page: q.Page, Size: q.Size}
	var all, ready, processing, failed int
	err := s.db.QueryRowContext(ctx, `SELECT count(*),
		coalesce(sum(CASE WHEN `+filterSQL["ready"]+` THEN 1 ELSE 0 END), 0),
		coalesce(sum(CASE WHEN `+filterSQL["processing"]+` THEN 1 ELSE 0 END), 0),
		coalesce(sum(CASE WHEN `+filterSQL["failed"]+` THEN 1 ELSE 0 END), 0)
		FROM videos v `+where, args...).Scan(
		&all, &ready, &processing, &failed)
	if err != nil {
		return LibraryPage{}, err
	}
	page.Counts = map[string]int{"all": all, "ready": ready, "processing": processing, "failed": failed}
	if cond, ok := filterSQL[q.Filter]; ok {
		where += " AND " + cond
	}
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM videos v `+where, args...).Scan(&page.Total); err != nil {
		return LibraryPage{}, err
	}
	page.Videos, err = s.listVideosPage(ctx, where, args, q.Size, (q.Page-1)*q.Size)
	return page, err
}

func escapeLike(term string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(term)
}

// GetOwnVideo returns one of ownerID's videos with its transcript.
func (s *Store) GetOwnVideo(ctx context.Context, ownerID, id string) (VideoDetail, error) {
	if err := s.checkOwner(ctx, ownerID, id); err != nil {
		return VideoDetail{}, err
	}
	return s.GetVideo(ctx, id)
}

// DeleteOwnVideo deletes one of ownerID's videos and returns its title.
func (s *Store) DeleteOwnVideo(ctx context.Context, ownerID, id string) (string, error) {
	var title string
	err := s.db.QueryRowContext(ctx, `DELETE FROM videos WHERE id = ? AND owner_id = ? RETURNING title`, id, ownerID).Scan(&title)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return title, err
}

// RequestOwnJob queues a run for one of ownerID's videos.
func (s *Store) RequestOwnJob(ctx context.Context, ownerID, videoID, kind string) (Job, error) {
	if err := s.checkOwner(ctx, ownerID, videoID); err != nil {
		return Job{}, err
	}
	return s.RequestJob(ctx, videoID, kind, ownerID)
}

func (s *Store) checkOwner(ctx context.Context, ownerID, videoID string) error {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM videos WHERE id = ? AND owner_id = ?`, videoID, ownerID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Added is the result of AddVideo.
type Added struct {
	Video Video `json:"video"`
	// Job is the run that will process the video, nil when it's already
	// ready (or already being processed: then it's that run).
	Job *Job `json:"job"`
	// Created is false when the video was already in the library.
	Created bool `json:"created"`
}

// AddVideo puts a YouTube video in ownerID's library and queues it for
// processing. A video already in the library is returned as it is: ready or
// being processed. Otherwise (failed, or left unfinished) it is queued again.
func (s *Store) AddVideo(ctx context.Context, ownerID, link string) (Added, error) {
	ytID, err := ParseYouTubeID(link)
	if err != nil {
		return Added{}, err
	}
	var existing, status string
	err = s.db.QueryRowContext(ctx, `SELECT id, status FROM videos WHERE owner_id = ? AND youtube_video_id = ?`,
		ownerID, ytID).Scan(&existing, &status)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		now := db.FormatTime(time.Now())
		existing = uuid.NewString()
		if _, err := s.db.ExecContext(ctx, `INSERT INTO videos
			(id, owner_id, youtube_video_id, youtube_url, title, thumbnail_url, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
			existing, ownerID, ytID, "https://www.youtube.com/watch?v="+ytID, "YouTube video "+ytID,
			"https://i.ytimg.com/vi/"+ytID+"/hqdefault.jpg", now, now); err != nil {
			return Added{}, err
		}
		job, err := s.RequestJob(ctx, existing, "process_video", ownerID)
		if err != nil {
			return Added{}, err
		}
		return s.added(ctx, existing, &job, true)
	case err != nil:
		return Added{}, err
	default:
		open, err := s.listJobs(ctx, `WHERE j.video_id = ? AND j.status IN ('queued', 'running')`, []any{existing}, 1, true)
		if err != nil {
			return Added{}, err
		}
		if len(open) == 1 {
			return s.added(ctx, existing, &open[0], false)
		}
		if status == "ready" {
			return s.added(ctx, existing, nil, false)
		}
		// Not ready and nothing running it: process it now.
		job, err := s.RequestJob(ctx, existing, "process_video", ownerID)
		if err != nil && !errors.Is(err, ErrJobOpen) {
			return Added{}, err
		}
		return s.added(ctx, existing, &job, false)
	}
}

func (s *Store) added(ctx context.Context, id string, job *Job, created bool) (Added, error) {
	videos, err := s.listVideos(ctx, "WHERE v.id = ?", []any{id})
	if err != nil {
		return Added{}, err
	}
	if len(videos) == 0 {
		return Added{}, ErrNotFound
	}
	return Added{Video: videos[0], Job: job, Created: created}, nil
}
