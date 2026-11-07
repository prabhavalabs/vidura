// Package auth handles sign-in, session cookies, and access control for the
// API. Each portal has one sign-in method and its own sessions:
//
//   - client portal: Google only
//   - admin portal: email and password only
//
// A session works only from the portal that created it.
package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
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

// Cookie names. Each portal has its own session cookie.
const (
	AdminSessionCookie  = "vidura_admin_session"
	ClientSessionCookie = "vidura_client_session"
	stateCookie         = "vidura_oauth"
)

// SessionCookieName returns the session cookie of portal app.
func SessionCookieName(app string) string {
	if app == config.AppAdmin {
		return AdminSessionCookie
	}
	return ClientSessionCookie
}

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
	// attempts bounds password tries per email, whatever the address.
	attempts *httpx.RateLimiter
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
		attempts: httpx.NewRateLimiter(10, 15*time.Minute),
		now:      time.Now,
	}
}

// Routes registers the /auth endpoints.
func (s *Service) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/methods", s.methods)
	mux.HandleFunc("GET /auth/google/start", s.limited(s.googleStart))
	mux.HandleFunc("GET /auth/google/callback", s.limited(s.googleCallback))
	mux.HandleFunc("POST /auth/logout", s.logout)
	if s.cfg.DevLogin || s.cfg.PasswordLogin {
		mux.HandleFunc("POST /auth/password", s.limited(s.passwordLogin))
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

// methods tells a portal's sign-in page which method it offers: Google for
// the client portal, email and password for the admin portal. The portal is
// the request's Origin, or ?app= without one.
func (s *Service) methods(w http.ResponseWriter, r *http.Request) {
	app := s.cfg.AppForOrigin(r.Header.Get("Origin"))
	if app == "" {
		app = appName(r.URL.Query().Get("app"))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"google":   app == config.AppClient && s.provider != nil,
		"password": app == config.AppAdmin && s.passwordEnabled(),
	})
}

func (s *Service) passwordEnabled() bool { return s.cfg.DevLogin || s.cfg.PasswordLogin }

// googleStart begins a Google sign-in for one portal. ?app=admin|client picks
// where the browser returns afterwards; ?next is a path on that portal.
func (s *Service) googleStart(w http.ResponseWriter, r *http.Request) {
	app := appName(r.URL.Query().Get("app"))
	next := SafeNext(r.URL.Query().Get("next"))
	if app == config.AppAdmin {
		s.redirectWithError(w, r, app, next, "method_not_allowed")
		return
	}
	if s.provider == nil {
		s.redirectWithError(w, r, app, next, "google_not_configured")
		return
	}
	state, err := newFlowState(app, next, s.now())
	if err != nil {
		slog.Error("create sign-in state", "error", err)
		s.redirectWithError(w, r, app, next, "server_error")
		return
	}
	signed, err := signFlowState(s.cfg.Secret, state)
	if err != nil {
		slog.Error("sign sign-in state", "error", err)
		s.redirectWithError(w, r, app, next, "server_error")
		return
	}
	target, err := s.provider.AuthURL(state.State, state.Nonce, state.Verifier)
	if err != nil {
		slog.Error("build google sign-in url", "error", err)
		s.redirectWithError(w, r, app, next, "google_unavailable")
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
	// Without a valid cookie the app comes from the state parameter's
	// prefix; it only picks which sign-in page shows the error.
	fallbackApp := appFromState(r.URL.Query().Get("state"))
	cookie, err := r.Cookie(stateCookie)
	if err != nil {
		s.redirectWithError(w, r, fallbackApp, "/", "session_expired")
		return
	}
	http.SetCookie(w, clearStateCookie) // single use, whatever happens next
	state, err := verifyFlowState(s.cfg.Secret, cookie.Value, s.now())
	if err != nil || r.URL.Query().Get("state") != state.State {
		s.redirectWithError(w, r, fallbackApp, "/", "session_expired")
		return
	}
	app := appName(state.App)
	if app == config.AppAdmin {
		s.redirectWithError(w, r, app, state.Next, "method_not_allowed")
		return
	}
	if r.URL.Query().Get("error") != "" {
		s.redirectWithError(w, r, app, state.Next, "cancelled")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" || s.provider == nil {
		s.redirectWithError(w, r, app, state.Next, "server_error")
		return
	}
	identity, err := s.provider.Exchange(r.Context(), code, state.Verifier, state.Nonce)
	if err != nil {
		slog.Warn("google sign-in exchange failed", "error", err)
		s.redirectWithError(w, r, app, state.Next, "google_failed")
		return
	}
	if code, ok := s.signIn(w, r, identity, app); !ok {
		s.redirectWithError(w, r, app, state.Next, code)
		return
	}
	http.Redirect(w, r, s.cfg.AppOrigin(app)+state.Next, http.StatusFound)
}

// passwordLogin signs in to the admin portal with an email and password: the
// account's own password (set with `vidura set-password`), or in development
// the shared local password. The client portal can't use it.
func (s *Service) passwordLogin(w http.ResponseWriter, r *http.Request) {
	switch s.cfg.AppForOrigin(r.Header.Get("Origin")) {
	case config.AppAdmin:
	case config.AppClient:
		httpx.WriteError(w, http.StatusForbidden, "method_not_allowed", "The client portal signs in with Google.")
		return
	default:
		httpx.WriteError(w, http.StatusForbidden, "bad_origin", "Cross-site request refused.")
		return
	}
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	email := config.NormalizeEmail(body.Email)
	if !s.attempts.Allow(email) {
		httpx.WriteError(w, http.StatusTooManyRequests, "rate_limited",
			"Too many attempts for this account. Try again in 15 minutes.")
		return
	}
	refuse := func() {
		s.audit.Record(r.Context(), audit.Entry{
			ActorEmail: email, Action: audit.SignInRefused, Target: email, IP: s.ip(r),
			Detail: map[string]any{"reason": "wrong_password"},
		})
		httpx.WriteError(w, http.StatusUnauthorized, "wrong_password", "The email or password is wrong.")
	}

	var user accounts.User
	var err error
	switch {
	case s.cfg.PasswordLogin:
		user, err = s.store.PasswordSignIn(r.Context(), email, body.Password)
		if errors.Is(err, accounts.ErrWrongPassword) && s.cfg.DevLogin && s.devPasswordMatches(body.Password) {
			user, err = s.store.DevSignIn(r.Context(), email)
		}
	case s.devPasswordMatches(body.Password):
		user, err = s.store.DevSignIn(r.Context(), email)
	default:
		err = accounts.ErrWrongPassword
	}
	if errors.Is(err, accounts.ErrWrongPassword) {
		refuse()
		return
	}
	if err != nil {
		s.recordRefusal(r, email, err)
		httpx.WriteError(w, http.StatusForbidden, refusalCode(err), err.Error())
		return
	}
	if !s.startSession(w, r, user, config.AppAdmin) {
		httpx.WriteError(w, http.StatusInternalServerError, "server_error", "Couldn't start a session.")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"user": PublicUser(user)})
}

// devPasswordMatches compares in constant time; hashing first keeps the
// comparison from leaking the password's length.
func (s *Service) devPasswordMatches(given string) bool {
	if s.cfg.DevPassword == "" {
		return false
	}
	want := sha256.Sum256([]byte(s.cfg.DevPassword))
	got := sha256.Sum256([]byte(given))
	return subtle.ConstantTimeCompare(want[:], got[:]) == 1
}

func (s *Service) logout(w http.ResponseWriter, r *http.Request) {
	app := s.cfg.AppForOrigin(r.Header.Get("Origin"))
	if app == "" {
		httpx.WriteError(w, http.StatusForbidden, "bad_origin", "Cross-site request refused.")
		return
	}
	if cookie, err := r.Cookie(SessionCookieName(app)); err == nil {
		if user, _, err := s.store.SessionUser(r.Context(), cookie.Value, app); err == nil {
			s.audit.Record(r.Context(), audit.Entry{
				ActorID: user.ID, ActorEmail: user.Email, Action: audit.SignOut, IP: s.ip(r),
			})
		}
		if err := s.store.DeleteSession(r.Context(), cookie.Value); err != nil {
			slog.Error("delete session", "error", err)
		}
	}
	http.SetCookie(w, s.sessionCookie(app, "", time.Time{}))
	w.WriteHeader(http.StatusNoContent)
}

// signIn applies the sign-in policy and starts a session, recording the
// outcome in the audit log. On refusal it returns the reason code.
func (s *Service) signIn(w http.ResponseWriter, r *http.Request, identity accounts.Identity, app string) (string, bool) {
	user, err := s.store.SignIn(r.Context(), identity)
	if err != nil {
		s.recordRefusal(r, identity.Email, err)
		return refusalCode(err), false
	}
	if !s.startSession(w, r, user, app) {
		return "server_error", false
	}
	return "", true
}

func (s *Service) startSession(w http.ResponseWriter, r *http.Request, user accounts.User, app string) bool {
	token, expires, err := s.store.CreateSession(r.Context(), user.ID, accounts.SessionMeta{
		App: app, UserAgent: r.UserAgent(), IP: s.ip(r),
	})
	if err != nil {
		slog.Error("create session", "error", err)
		return false
	}
	http.SetCookie(w, s.sessionCookie(app, token, expires))
	s.audit.Record(r.Context(), audit.Entry{
		ActorID: user.ID, ActorEmail: user.Email, Action: audit.SignIn, IP: s.ip(r),
		Detail: map[string]any{"role": user.Role, "portal": app},
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

func (s *Service) sessionCookie(app, token string, expires time.Time) *http.Cookie {
	cookie := &http.Cookie{
		Name:     SessionCookieName(app),
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

// redirectWithError sends the browser back to the sign-in page of the portal
// it came from, with a reason code the page can explain.
func (s *Service) redirectWithError(w http.ResponseWriter, r *http.Request, app, next, code string) {
	query := url.Values{"error": {code}}
	if next != "/" {
		query.Set("next", next)
	}
	http.Redirect(w, r, s.cfg.AppOrigin(app)+"/login?"+query.Encode(), http.StatusFound)
}

func (s *Service) ip(r *http.Request) string { return httpx.ClientIP(r, s.cfg.TrustProxy) }

// allowedOrigin reports whether a state-changing request comes from one of
// the two portals. Browsers always send Origin on cross-origin requests and
// on same-origin POSTs, so a missing Origin is refused too.
func (s *Service) allowedOrigin(r *http.Request) bool {
	return s.cfg.AppForOrigin(r.Header.Get("Origin")) != ""
}

// appName narrows an app name from a URL to a known one.
func appName(app string) string {
	if app == config.AppAdmin {
		return config.AppAdmin
	}
	return config.AppClient
}

func appFromState(state string) string {
	app, _, _ := strings.Cut(state, ".")
	return appName(app)
}

// --- Middleware -----------------------------------------------------------

// Middleware resolves the session of the portal the request comes from (its
// Origin) and attaches the user to the request context. Requests from no
// portal have no user. It never rejects a request; RequireUser does.
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		app := s.cfg.AppForOrigin(r.Header.Get("Origin"))
		if app == "" {
			next.ServeHTTP(w, r)
			return
		}
		cookie, err := r.Cookie(SessionCookieName(app))
		if err != nil || cookie.Value == "" {
			next.ServeHTTP(w, r)
			return
		}
		user, renewed, err := s.store.SessionUser(r.Context(), cookie.Value, app)
		if err != nil {
			if !errors.Is(err, accounts.ErrNotFound) && !errors.Is(err, accounts.ErrDisabled) {
				slog.Error("resolve session", "error", err)
			}
			http.SetCookie(w, s.sessionCookie(app, "", time.Time{}))
			next.ServeHTTP(w, r)
			return
		}
		if !renewed.IsZero() {
			http.SetCookie(w, s.sessionCookie(app, cookie.Value, renewed))
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
		if !safeMethod(r.Method) && !s.allowedOrigin(r) {
			httpx.WriteError(w, http.StatusForbidden, "bad_origin", "Cross-site request refused.")
			return
		}
		next(w, r)
	}
}

// RequireSuperuser is RequireUser for the admin API: every request must come
// from the admin portal itself, so only admin-portal sessions get through.
func (s *Service) RequireSuperuser(next http.HandlerFunc) http.HandlerFunc {
	return s.RequireUser(func(w http.ResponseWriter, r *http.Request) {
		user, _ := UserFrom(r.Context())
		if !user.IsSuperuser() {
			httpx.WriteError(w, http.StatusForbidden, "forbidden", "This needs a superuser account.")
			return
		}
		// Reads too: only the admin portal, so only an admin-portal session
		// (email and password), reaches the admin API.
		if r.Header.Get("Origin") != s.cfg.AdminOrigin() {
			httpx.WriteError(w, http.StatusForbidden, "bad_origin", "The admin API only answers the admin portal.")
			return
		}
		next(w, r)
	})
}

// RequireClient is RequireUser for the client API: every request must come
// from the client portal, so only client-portal (Google) sessions get through.
func (s *Service) RequireClient(next http.HandlerFunc) http.HandlerFunc {
	return s.RequireUser(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != s.cfg.ClientOrigin() {
			httpx.WriteError(w, http.StatusForbidden, "bad_origin", "The client API only answers the client portal.")
			return
		}
		next(w, r)
	})
}

func safeMethod(method string) bool { return method == http.MethodGet || method == http.MethodHead }

// PublicUser is the JSON shape of a user.
func PublicUser(user accounts.User) map[string]any {
	return map[string]any{
		"id":         user.ID,
		"email":      user.Email,
		"name":       user.Name,
		"imageUrl":   user.ImageURL,
		"role":       user.Role,
		"status":     user.Status,
		"locale":     user.Locale,
		"owner":      user.Owner,
		"createdAt":  user.CreatedAt,
		"lastSeenAt": user.LastSeenAt,
	}
}
