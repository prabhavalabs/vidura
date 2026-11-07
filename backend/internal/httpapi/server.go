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
	"github.com/prabhavalabs/vidura/backend/internal/agenthub"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/catalog"
	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/httpx"
	"github.com/prabhavalabs/vidura/backend/internal/learn"
	"github.com/prabhavalabs/vidura/backend/internal/push"
	"github.com/prabhavalabs/vidura/backend/internal/settings"
)

// Deps are the server's collaborators.
type Deps struct {
	Config   *config.Config
	DB       *sql.DB
	Accounts *accounts.Store
	Audit    *audit.Log
	Auth     *auth.Service
	// AdminUI and ClientUI are the built portals (index.html at their root).
	// Either may be empty; that host then explains how to build it.
	AdminUI  fs.FS
	ClientUI fs.FS
	Version  string
	// ChatGPT runs the Codex CLI; nil when the server can't (tests).
	ChatGPT *chatgpt.Manager
	// Hub holds transcription agents; created here when nil.
	Hub *agenthub.Hub
	// JobQueued wakes the worker after a run is queued; may be nil.
	JobQueued func()
	// Push sends notifications to the client portal; nil turns them off.
	Push *push.Service
	// Learn makes study notes, answers questions and draws pictures; nil
	// turns those off.
	Learn *learn.Service
}

// Server is the HTTP handler for the whole app. One process answers three
// hosts and picks the handler by the Host header:
//
//	VIDURA_API_URL     /api, /auth, /healthz, /readyz (JSON only)
//	VIDURA_ADMIN_URL   the admin portal (static single-page app)
//	VIDURA_CLIENT_URL  the client portal (static single-page app)
//
// Any other host (a health check on localhost, say) gets the API.
type Server struct {
	deps     Deps
	catalog  *catalog.Store
	settings *settings.Store
	hub      *agenthub.Hub
	started  time.Time
	handler  http.Handler
}

// New builds the server.
func New(deps Deps) *Server {
	s := &Server{deps: deps, catalog: catalog.NewStore(deps.DB), settings: settings.NewStore(deps.DB),
		hub: deps.Hub, started: time.Now()}
	if s.hub == nil {
		s.hub = agenthub.New(deps.DB, deps.Audit, deps.Config.TrustProxy)
	}
	cfg := deps.Config

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /readyz", s.readyz)
	deps.Auth.Routes(mux)
	mux.HandleFunc("GET /api/me", deps.Auth.RequireUser(s.me))
	s.adminRoutes(mux)
	s.catalogRoutes(mux)
	s.libraryRoutes(mux)
	s.preferenceRoutes(mux)
	s.learnRoutes(mux)
	s.voiceRoutes(mux)
	s.systemRoutes(mux)
	s.hub.Routes(mux)
	mux.HandleFunc("/", notFound)
	api := cors(cfg, deps.Auth.Middleware(mux))

	admin := spa(deps.AdminUI, "admin portal", "Run `make admin`, then rebuild the server.", cfg.APIOrigin())
	client := spa(deps.ClientUI, "client portal", "Run `make client`, then rebuild the server.", cfg.APIOrigin())

	adminHost, clientHost := cfg.AdminURL.Host, cfg.ClientURL.Host
	adminPolicy, clientPolicy := adminCSP(cfg.APIOrigin()), clientCSP(cfg.APIOrigin())
	byHost := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch strings.ToLower(r.Host) {
		case adminHost:
			w.Header().Set("Content-Security-Policy", adminPolicy)
			w.Header().Set("Referrer-Policy", portalReferrer)
			admin.ServeHTTP(w, r)
		case clientHost:
			w.Header().Set("Content-Security-Policy", clientPolicy)
			w.Header().Set("Referrer-Policy", portalReferrer)
			// Voice questions record from the microphone, on this page only.
			w.Header().Set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()")
			client.ServeHTTP(w, r)
		default:
			w.Header().Set("Content-Security-Policy", apiCSP)
			api.ServeHTTP(w, r)
		}
	})

	s.handler = recoverPanics(logRequests(securityHeaders(cfg, byHost)))
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

const apiCSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

// portalReferrer lets the portals' YouTube embeds send the page's origin
// (never its path) as the Referer, which YouTube requires to play a video.
const portalReferrer = "strict-origin-when-cross-origin"

// adminCSP is the admin portal's policy: its own files, calls to the API,
// and the no-cookie YouTube embed for previews.
func adminCSP(apiOrigin string) string {
	return portalCSP(apiOrigin, "'self'", "https://www.youtube-nocookie.com", "")
}

// clientCSP is the client portal's: the same, plus YouTube's IFrame Player
// API (its script and player frame), which subtitles sync against.
func clientCSP(apiOrigin string) string {
	return portalCSP(apiOrigin,
		"'self' https://www.youtube.com https://s.ytimg.com",
		"https://www.youtube.com https://www.youtube-nocookie.com",
		// Explanatory pictures, by signed address.
		apiOrigin+"/media/")
}

func portalCSP(apiOrigin, scripts, frames, images string) string {
	if images != "" {
		images = " " + images
	}
	return "default-src 'self'; script-src " + scripts + "; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: https://*.googleusercontent.com https://i.ytimg.com" + images + "; font-src 'self' data:; " +
		"connect-src 'self' " + apiOrigin + "; frame-src " + frames + "; " +
		"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
}

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
		next.ServeHTTP(w, r)
	})
}

// cors lets the two portals call the API with the session cookie. Only their
// exact origins are echoed back, and the admin API answers only the admin
// portal. Writes are checked again by auth (Origin allowlist), so CORS is
// what lets a portal read responses, not what protects writes.
func cors(cfg *config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		app := cfg.AppForOrigin(origin)
		allowed := app == config.AppAdmin ||
			(app == config.AppClient && !strings.HasPrefix(r.URL.Path, "/api/admin/"))
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			if !allowed {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
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
