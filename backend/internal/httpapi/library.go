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

// libraryRoutes is the client portal's API: each signed-in user's own
// videos. Only the client portal can call it (auth.RequireClient), and a
// video that belongs to someone else answers 404.
func (s *Server) libraryRoutes(mux *http.ServeMux) {
	c := s.deps.Auth.RequireClient
	mux.HandleFunc("GET /api/videos", c(s.listOwnVideos))
	mux.HandleFunc("POST /api/videos", c(s.addVideo))
	mux.HandleFunc("GET /api/videos/{id}", c(s.getOwnVideo))
	mux.HandleFunc("DELETE /api/videos/{id}", c(s.deleteOwnVideo))
	mux.HandleFunc("POST /api/videos/{id}/jobs", c(s.requestOwnJob))
}

// listOwnVideos answers ?q=search&filter=ready|processing|failed&page=1&size=24.
func (s *Server) listOwnVideos(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	query := r.URL.Query()
	q := catalog.LibraryQuery{Search: query.Get("q"), Filter: query.Get("filter")}
	if len(q.Search) > 200 || !catalog.LibraryFilters[q.Filter] {
		httpx.WriteError(w, http.StatusBadRequest, "bad_query", "Unknown filter or search too long.")
		return
	}
	q.Page, _ = strconv.Atoi(query.Get("page"))
	q.Size, _ = strconv.Atoi(query.Get("size"))
	page, err := s.catalog.ListOwnVideos(r.Context(), user.ID, q)
	if err != nil {
		serverError(w, "list own videos", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, page)
}

func (s *Server) addVideo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	added, err := s.catalog.AddVideo(r.Context(), user.ID, body.URL)
	switch {
	case errors.Is(err, catalog.ErrBadURL):
		httpx.WriteError(w, http.StatusBadRequest, "bad_url", "That isn’t a YouTube video link.")
		return
	case err != nil:
		serverError(w, "add video", err)
		return
	}
	if added.Created {
		s.recordAsActor(r, audit.VideoAdded, added.Video.ID, map[string]any{"youtubeId": added.Video.YouTubeID})
	}
	if added.Job != nil && s.deps.JobQueued != nil {
		s.deps.JobQueued()
	}
	status := http.StatusOK
	if added.Created {
		status = http.StatusCreated
	}
	httpx.WriteJSON(w, status, added)
}

func (s *Server) getOwnVideo(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	detail, err := s.catalog.GetOwnVideo(r.Context(), user.ID, r.PathValue("id"))
	if errors.Is(err, catalog.ErrNotFound) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "No such video.")
		return
	}
	if err != nil {
		serverError(w, "get own video", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, detail)
}

func (s *Server) deleteOwnVideo(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	id := r.PathValue("id")
	title, err := s.catalog.DeleteOwnVideo(r.Context(), user.ID, id)
	if errors.Is(err, catalog.ErrNotFound) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "No such video.")
		return
	}
	if err != nil {
		serverError(w, "delete own video", err)
		return
	}
	s.recordAsActor(r, audit.VideoDeleted, id, map[string]any{"title": title})
	if s.deps.Learn != nil {
		s.deps.Learn.ForgetVideo(id)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) requestOwnJob(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind string `json:"kind"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	videoID := r.PathValue("id")
	job, err := s.catalog.RequestOwnJob(r.Context(), user.ID, videoID, body.Kind)
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
		serverError(w, "request own job", err)
	default:
		s.recordAsActor(r, audit.JobRequested, videoID, map[string]any{"kind": body.Kind, "job": job.ID})
		if s.deps.JobQueued != nil {
			s.deps.JobQueued()
		}
		httpx.WriteJSON(w, http.StatusCreated, map[string]any{"job": job})
	}
}
