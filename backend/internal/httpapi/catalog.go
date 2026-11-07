package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/catalog"
	"github.com/prabhavalabs/vidura/backend/internal/httpx"
)

func (s *Server) catalogRoutes(mux *http.ServeMux) {
	su := s.deps.Auth.RequireSuperuser
	mux.HandleFunc("GET /api/admin/stats", su(s.adminStats))
	mux.HandleFunc("GET /api/admin/videos", su(s.adminListVideos))
	mux.HandleFunc("GET /api/admin/videos/{id}", su(s.adminGetVideo))
	mux.HandleFunc("GET /api/admin/jobs", su(s.adminListJobs))
	mux.HandleFunc("DELETE /api/admin/videos/{id}", su(s.adminDeleteVideo))
	mux.HandleFunc("POST /api/admin/videos/{id}/jobs", su(s.adminRequestJob))
	mux.HandleFunc("POST /api/admin/jobs/{id}/cancel", su(s.adminCancelJob))
}

func (s *Server) adminDeleteVideo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	title, err := s.catalog.DeleteVideo(r.Context(), id)
	if errors.Is(err, catalog.ErrNotFound) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "No such video.")
		return
	}
	if err != nil {
		serverError(w, "delete video", err)
		return
	}
	s.recordAsActor(r, audit.VideoDeleted, id, map[string]any{"title": title})
	if s.deps.Learn != nil {
		s.deps.Learn.ForgetVideo(id)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) adminRequestJob(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind string `json:"kind"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	actor, _ := auth.UserFrom(r.Context())
	videoID := r.PathValue("id")
	job, err := s.catalog.RequestJob(r.Context(), videoID, body.Kind, actor.ID)
	switch {
	case errors.Is(err, catalog.ErrBadKind):
		httpx.WriteError(w, http.StatusBadRequest, "bad_kind", "Unknown kind of run.")
	case errors.Is(err, catalog.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "No such video.")
	case errors.Is(err, catalog.ErrJobOpen):
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error": map[string]string{"code": "job_open", "message": err.Error()},
			"job":   job,
		})
	case err != nil:
		serverError(w, "request job", err)
	default:
		s.recordAsActor(r, audit.JobRequested, videoID, map[string]any{"kind": body.Kind, "job": job.ID})
		if s.deps.JobQueued != nil {
			s.deps.JobQueued()
		}
		httpx.WriteJSON(w, http.StatusCreated, map[string]any{"job": job})
	}
}

func (s *Server) adminCancelJob(w http.ResponseWriter, r *http.Request) {
	job, err := s.catalog.CancelJob(r.Context(), r.PathValue("id"))
	switch {
	case errors.Is(err, catalog.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "No such run.")
	case errors.Is(err, catalog.ErrNotCancellable):
		httpx.WriteError(w, http.StatusConflict, "not_cancellable", err.Error())
	case err != nil:
		serverError(w, "cancel job", err)
	default:
		s.recordAsActor(r, audit.JobCancelled, job.ID, map[string]any{"video": job.Video.ID})
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"job": job})
	}
}

func (s *Server) adminStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.catalog.Stats(r.Context())
	if err != nil {
		serverError(w, "stats", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, stats)
}

func (s *Server) adminListVideos(w http.ResponseWriter, r *http.Request) {
	videos, err := s.catalog.ListVideos(r.Context())
	if err != nil {
		serverError(w, "list videos", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"videos": videos})
}

func (s *Server) adminGetVideo(w http.ResponseWriter, r *http.Request) {
	detail, err := s.catalog.GetVideo(r.Context(), r.PathValue("id"))
	if errors.Is(err, catalog.ErrNotFound) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "No such video.")
		return
	}
	if err != nil {
		serverError(w, "get video", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, detail)
}

var jobStatuses = map[string]bool{"": true, "queued": true, "running": true, "succeeded": true, "failed": true, "cancelled": true}

func (s *Server) adminListJobs(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if !jobStatuses[status] {
		httpx.WriteError(w, http.StatusBadRequest, "bad_status", "Unknown job status.")
		return
	}
	limit := 500
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	jobs, err := s.catalog.ListJobs(r.Context(), status, limit)
	if err != nil {
		serverError(w, "list jobs", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}
