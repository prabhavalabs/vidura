// Package httpapi wires the HTTP routes, middleware and static apps together.
package httpapi

import (
	"database/sql"
	"io/fs"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/httpx"
)

// Deps are the server's collaborators.
type Deps struct {
	Config   *config.Config
	DB       *sql.DB
	Accounts *accounts.Store
	Audit    *audit.Log
	Auth     *auth.Service
	// AdminUI is the built admin portal (index.html at its root). It may be
	// empty, in which case /admin explains how to build it.
	AdminUI fs.FS
	Version string
}

// Server is the HTTP handler for the whole app.
type Server struct {
	deps    Deps
	started time.Time
	handler http.Handler
}

// New builds the server.
func New(deps Deps) *Server {
	s := &Server{deps: deps, started: time.Now()}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /readyz", s.readyz)

	deps.Auth.Routes(mux)
	mux.HandleFunc("GET /api/me", deps.Auth.RequireUser(s.me))

	s.adminRoutes(mux)

	mux.Handle("/admin/", s.adminUI())
	mux.HandleFunc("GET /admin", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin/", http.StatusMovedPermanently)
	})
	// The client app moves here in a later phase; until then the root leads
	// to the admin portal.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin/", http.StatusFound)
	})
	mux.HandleFunc("/api/", notFound)
	mux.HandleFunc("/admin/api/", notFound)

	s.handler = recoverPanics(logRequests(securityHeaders(deps.Config, deps.Auth.Middleware(mux))))
	return s
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.DB.PingContext(r.Context()); err != nil {
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"user": auth.PublicUser(user)})
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteError(w, http.StatusNotFound, "not_found", "No such endpoint.")
}

// --- middleware -----------------------------------------------------------

const (
	apiCSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
	appCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: https://*.googleusercontent.com; font-src 'self' data:; " +
		"connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)

func securityHeaders(cfg *config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if cfg.Production() {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		if isAPIPath(r.URL.Path) {
			h.Set("Content-Security-Policy", apiCSP)
		} else {
			h.Set("Content-Security-Policy", appCSP)
		}
		next.ServeHTTP(w, r)
	})
}

func isAPIPath(path string) bool {
	return strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/admin/api/") ||
		strings.HasPrefix(path, "/auth/") || path == "/healthz" || path == "/readyz"
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Flush keeps streaming responses (SSE) working through the recorder.
func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		if r.URL.Path == "/healthz" {
			return
		}
		level := slog.LevelInfo
		if recorder.status >= 500 {
			level = slog.LevelError
		}
		// Never log query strings: OAuth callbacks carry codes in them.
		slog.Log(r.Context(), level, "http", "method", r.Method, "path", r.URL.Path,
			"status", recorder.status, "ms", time.Since(start).Milliseconds())
	})
}

func recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				if recovered == http.ErrAbortHandler {
					panic(recovered)
				}
				slog.Error("panic", "path", r.URL.Path, "value", recovered, "stack", string(debug.Stack()))
				httpx.WriteError(w, http.StatusInternalServerError, "server_error", "Something went wrong.")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
