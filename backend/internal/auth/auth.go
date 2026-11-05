// Package auth handles sign-in (Google OAuth, and a development shortcut),
// session cookies, and access control for the API.
package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/httpx"
)

// Cookie names.
const (
	SessionCookie = "vidura_session"
	stateCookie   = "vidura_oauth"
)

type contextKey struct{}

// UserFrom returns the signed-in user attached by Middleware, if any.
func UserFrom(ctx context.Context) (accounts.User, bool) {
	user, ok := ctx.Value(contextKey{}).(accounts.User)
	return user, ok
}

// WithUser attaches user to ctx (tests and middleware).
func WithUser(ctx context.Context, user accounts.User) context.Context {
	return context.WithValue(ctx, contextKey{}, user)
}

// Service serves the /auth endpoints and authenticates requests.
type Service struct {
	cfg      *config.Config
	store    *accounts.Store
	audit    *audit.Log
	provider Provider // nil when Google isn't configured
	limiter  *httpx.RateLimiter
	now      func() time.Time
}

// NewService returns a Service. provider may be nil.
func NewService(cfg *config.Config, store *accounts.Store, auditLog *audit.Log, provider Provider) *Service {
	return &Service{
		cfg:      cfg,
		store:    store,
		audit:    auditLog,
		provider: provider,
		limiter:  httpx.NewRateLimiter(20, time.Minute),
		now:      time.Now,
	}
}

// Routes registers the /auth endpoints.
func (s *Service) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/google/start", s.limited(s.googleStart))
	mux.HandleFunc("GET /auth/google/callback", s.limited(s.googleCallback))
	mux.HandleFunc("POST /auth/logout", s.logout)
	if s.cfg.DevLogin {
		mux.HandleFunc("POST /auth/dev-login", s.limited(s.devLogin))
	}
}

func (s *Service) limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.limiter.Allow(httpx.ClientIP(r, s.cfg.TrustProxy)) {
			httpx.WriteError(w, http.StatusTooManyRequests, "rate_limited", "Too many sign-in attempts. Try again in a minute.")
			return
		}
		next(w, r)
	}
}

func (s *Service) googleStart(w http.ResponseWriter, r *http.Request) {
	next := SafeNext(r.URL.Query().Get("next"))
	if s.provider == nil {
		s.redirectWithError(w, r, next, "google_not_configured")
		return
	}
	state, err := newFlowState(next, s.now())
	if err != nil {
		slog.Error("create sign-in state", "error", err)
		s.redirectWithError(w, r, next, "server_error")
		return
	}
	signed, err := signFlowState(s.cfg.Secret, state)
	if err != nil {
		slog.Error("sign sign-in state", "error", err)
		s.redirectWithError(w, r, next, "server_error")
		return
	}
	target, err := s.provider.AuthURL(state.State, state.Nonce, state.Verifier)
	if err != nil {
		slog.Error("build google sign-in url", "error", err)
		s.redirectWithError(w, r, next, "google_unavailable")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookie,
		Value:    signed,
		Path:     "/auth/",
		MaxAge:   int(flowStateTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.SecureCookies(),
		// Lax: the callback is a top-level navigation back from Google.
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, target, http.StatusFound)
}

func (s *Service) googleCallback(w http.ResponseWriter, r *http.Request) {
	clearStateCookie := &http.Cookie{
		Name: stateCookie, Value: "", Path: "/auth/", MaxAge: -1,
		HttpOnly: true, Secure: s.cfg.SecureCookies(), SameSite: http.SameSiteLaxMode,
	}
	cookie, err := r.Cookie(stateCookie)
	if err != nil {
		s.redirectWithError(w, r, "/", "session_expired")
		return
	}
	http.SetCookie(w, clearStateCookie) // single use, whatever happens next
	state, err := verifyFlowState(s.cfg.Secret, cookie.Value, s.now())
	if err != nil || r.URL.Query().Get("state") != state.State {
		s.redirectWithError(w, r, "/", "session_expired")
		return
	}
	if r.URL.Query().Get("error") != "" {
		s.redirectWithError(w, r, state.Next, "cancelled")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" || s.provider == nil {
		s.redirectWithError(w, r, state.Next, "server_error")
		return
	}
	identity, err := s.provider.Exchange(r.Context(), code, state.Verifier, state.Nonce)
	if err != nil {
		slog.Warn("google sign-in exchange failed", "error", err)
		s.redirectWithError(w, r, state.Next, "google_failed")
		return
	}
	if code, ok := s.signIn(w, r, identity); !ok {
		s.redirectWithError(w, r, state.Next, code)
		return
	}
	http.Redirect(w, r, state.Next, http.StatusFound)
}

// devLogin signs in an allowed email without Google (development only).
func (s *Service) devLogin(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(r) {
		httpx.WriteError(w, http.StatusForbidden, "bad_origin", "Cross-site request refused.")
		return
	}
	var body struct {
		Email string `json:"email"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, err := s.store.DevSignIn(r.Context(), body.Email)
	if err != nil {
		s.recordRefusal(r, body.Email, err)
		httpx.WriteError(w, http.StatusForbidden, refusalCode(err), err.Error())
		return
	}
	if !s.startSession(w, r, user) {
		httpx.WriteError(w, http.StatusInternalServerError, "server_error", "Couldn't start a session.")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"user": PublicUser(user)})
}

func (s *Service) logout(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(r) {
		httpx.WriteError(w, http.StatusForbidden, "bad_origin", "Cross-site request refused.")
		return
	}
	if cookie, err := r.Cookie(SessionCookie); err == nil {
		if user, _, err := s.store.SessionUser(r.Context(), cookie.Value); err == nil {
			s.audit.Record(r.Context(), audit.Entry{
				ActorID: user.ID, ActorEmail: user.Email, Action: audit.SignOut, IP: s.ip(r),
			})
		}
		if err := s.store.DeleteSession(r.Context(), cookie.Value); err != nil {
			slog.Error("delete session", "error", err)
		}
	}
	http.SetCookie(w, s.sessionCookie("", time.Time{}))
	w.WriteHeader(http.StatusNoContent)
}

// signIn applies the sign-in policy and starts a session, recording the
// outcome in the audit log. On refusal it returns the reason code.
func (s *Service) signIn(w http.ResponseWriter, r *http.Request, identity accounts.Identity) (string, bool) {
	user, err := s.store.SignIn(r.Context(), identity)
	if err != nil {
		s.recordRefusal(r, identity.Email, err)
		return refusalCode(err), false
	}
	if !s.startSession(w, r, user) {
		return "server_error", false
	}
	return "", true
}

func (s *Service) startSession(w http.ResponseWriter, r *http.Request, user accounts.User) bool {
	token, expires, err := s.store.CreateSession(r.Context(), user.ID, accounts.SessionMeta{
		UserAgent: r.UserAgent(), IP: s.ip(r),
	})
	if err != nil {
		slog.Error("create session", "error", err)
		return false
	}
	http.SetCookie(w, s.sessionCookie(token, expires))
	s.audit.Record(r.Context(), audit.Entry{
		ActorID: user.ID, ActorEmail: user.Email, Action: audit.SignIn, IP: s.ip(r),
		Detail: map[string]any{"role": user.Role},
	})
	return true
}

func (s *Service) recordRefusal(r *http.Request, email string, err error) {
	s.audit.Record(r.Context(), audit.Entry{
		ActorEmail: config.NormalizeEmail(email), Action: audit.SignInRefused,
		Target: config.NormalizeEmail(email), IP: s.ip(r),
		Detail: map[string]any{"reason": refusalCode(err)},
	})
}

func refusalCode(err error) string {
	switch {
	case errors.Is(err, accounts.ErrNotAllowed):
		return "not_invited"
	case errors.Is(err, accounts.ErrDisabled):
		return "disabled"
	case errors.Is(err, accounts.ErrUnverifiedEmail):
		return "unverified_email"
	case errors.Is(err, accounts.ErrConflict):
		return "account_conflict"
	case errors.Is(err, accounts.ErrInvalidEmail):
		return "invalid_email"
	default:
		return "server_error"
	}
}

func (s *Service) sessionCookie(token string, expires time.Time) *http.Cookie {
	cookie := &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.SecureCookies(),
		SameSite: http.SameSiteLaxMode,
	}
	if token == "" {
		cookie.MaxAge = -1
	} else {
		cookie.Expires = expires
	}
	return cookie
}

// redirectWithError sends the browser back to the sign-in page of the app it
// came from, with a reason code the page can explain.
func (s *Service) redirectWithError(w http.ResponseWriter, r *http.Request, next, code string) {
	login := "/login"
	if next == "/admin" || strings.HasPrefix(next, "/admin/") {
		login = "/admin/login"
	}
	query := url.Values{"error": {code}}
	if next != "/" {
		query.Set("next", next)
	}
	http.Redirect(w, r, login+"?"+query.Encode(), http.StatusFound)
}

func (s *Service) ip(r *http.Request) string { return httpx.ClientIP(r, s.cfg.TrustProxy) }

// sameOrigin reports whether a state-changing request comes from the app's
// own pages. Browsers always send Origin on cross-site and same-site POSTs.
func (s *Service) sameOrigin(r *http.Request) bool {
	return r.Header.Get("Origin") == s.cfg.Origin()
}

// --- Middleware -----------------------------------------------------------

// Middleware resolves the session cookie and attaches the user to the
// request context. It never rejects a request; RequireUser does.
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(SessionCookie)
		if err != nil || cookie.Value == "" {
			next.ServeHTTP(w, r)
			return
		}
		user, renewed, err := s.store.SessionUser(r.Context(), cookie.Value)
		if err != nil {
			if !errors.Is(err, accounts.ErrNotFound) && !errors.Is(err, accounts.ErrDisabled) {
				slog.Error("resolve session", "error", err)
			}
			http.SetCookie(w, s.sessionCookie("", time.Time{}))
			next.ServeHTTP(w, r)
			return
		}
		if !renewed.IsZero() {
			http.SetCookie(w, s.sessionCookie(cookie.Value, renewed))
		}
		next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), user)))
	})
}

// RequireUser rejects requests without a signed-in user, and state-changing
// requests from another origin.
func (s *Service) RequireUser(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := UserFrom(r.Context()); !ok {
			httpx.WriteError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !s.sameOrigin(r) {
			httpx.WriteError(w, http.StatusForbidden, "bad_origin", "Cross-site request refused.")
			return
		}
		next(w, r)
	}
}

// RequireSuperuser is RequireUser for the admin API.
func (s *Service) RequireSuperuser(next http.HandlerFunc) http.HandlerFunc {
	return s.RequireUser(func(w http.ResponseWriter, r *http.Request) {
		user, _ := UserFrom(r.Context())
		if !user.IsSuperuser() {
			httpx.WriteError(w, http.StatusForbidden, "forbidden", "This needs a superuser account.")
			return
		}
		next(w, r)
	})
}

// PublicUser is the JSON shape of a user.
func PublicUser(user accounts.User) map[string]any {
	return map[string]any{
		"id":         user.ID,
		"email":      user.Email,
		"name":       user.Name,
		"imageUrl":   user.ImageURL,
		"role":       user.Role,
		"status":     user.Status,
		"owner":      user.Owner,
		"createdAt":  user.CreatedAt,
		"lastSeenAt": user.LastSeenAt,
	}
}
