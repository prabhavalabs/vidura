package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// fakeProvider stands in for Google. It remembers the state and nonce it was
// given, and returns a configurable identity on exchange.
type fakeProvider struct {
	state, nonce, verifier string
	identity               accounts.Identity
	exchangeErr            error
}

func (f *fakeProvider) AuthURL(state, nonce, verifier string) (string, error) {
	f.state, f.nonce, f.verifier = state, nonce, verifier
	return "https://accounts.example/auth?state=" + url.QueryEscape(state), nil
}

func (f *fakeProvider) Exchange(_ context.Context, code, verifier, nonce string) (accounts.Identity, error) {
	if f.exchangeErr != nil {
		return accounts.Identity{}, f.exchangeErr
	}
	if code != "good-code" || verifier != f.verifier || nonce != f.nonce {
		return accounts.Identity{}, errors.New("bad exchange")
	}
	return f.identity, nil
}

type harness struct {
	t        *testing.T
	service  *Service
	store    *accounts.Store
	audit    *audit.Log
	provider *fakeProvider
	mux      *http.ServeMux
}

const (
	apiOrigin    = "https://api-vidura.example.com"
	adminOrigin  = "https://admin-vidura.example.com"
	clientOrigin = "https://vidura.example.com"
)

func mustURL(raw string) *url.URL {
	parsed, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return parsed
}

func newHarness(t *testing.T, options ...func(*config.Config)) *harness {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })

	cfg := &config.Config{
		Env:             config.EnvProduction,
		APIURL:          mustURL(apiOrigin),
		AdminURL:        mustURL(adminOrigin),
		ClientURL:       mustURL(clientOrigin),
		Secret:          []byte(strings.Repeat("k", 32)),
		SuperuserEmails: map[string]bool{"owner@example.com": true},
	}
	for _, option := range options {
		option(cfg)
	}
	store := accounts.NewStore(database, cfg)
	auditLog := audit.New(database)
	provider := &fakeProvider{identity: accounts.Identity{
		Subject: "owner-sub", Email: "owner@example.com", EmailVerified: true, Name: "Owner",
	}}
	service := NewService(cfg, store, auditLog, provider)

	mux := http.NewServeMux()
	service.Routes(mux)
	mux.HandleFunc("GET /api/me", service.RequireUser(func(w http.ResponseWriter, r *http.Request) {
		user, _ := UserFrom(r.Context())
		_, _ = w.Write([]byte(user.Email))
	}))
	mux.HandleFunc("POST /api/admin/thing", service.RequireSuperuser(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	return &harness{t: t, service: service, store: store, audit: auditLog, provider: provider, mux: mux}
}

func (h *harness) do(r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.service.Middleware(h.mux).ServeHTTP(w, r)
	return w
}

func cookieNamed(w *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// signIn runs the whole Google flow for app and returns the callback response.
func (h *harness) signIn(app, next string) *httptest.ResponseRecorder {
	start := h.do(httptest.NewRequest(http.MethodGet,
		"/auth/google/start?app="+app+"&next="+url.QueryEscape(next), nil))
	require.Equal(h.t, http.StatusFound, start.Code)
	state := cookieNamed(start, stateCookie)
	require.NotNil(h.t, state)

	callback := httptest.NewRequest(http.MethodGet,
		"/auth/google/callback?code=good-code&state="+url.QueryEscape(h.provider.state), nil)
	callback.AddCookie(state)
	return h.do(callback)
}

// get sends a GET from a portal's origin with a session cookie.
func (h *harness) get(path, origin string, session *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if session != nil {
		r.AddCookie(session)
	}
	return h.do(r)
}

// adminSession signs the owner in to the admin portal with a password.
func (h *harness) adminSession() *http.Cookie {
	h.t.Helper()
	_, err := h.store.SetPassword(context.Background(), "owner@example.com", "owner-password")
	require.NoError(h.t, err)
	w := h.devLogin(adminOrigin, `{"email":"owner@example.com","password":"owner-password"}`)
	require.Equal(h.t, http.StatusOK, w.Code, w.Body.String())
	session := cookieNamed(w, AdminSessionCookie)
	require.NotNil(h.t, session)
	return session
}

func passwordHarness(t *testing.T) *harness {
	return newHarness(t, func(cfg *config.Config) { cfg.PasswordLogin = true })
}

func TestGoogleFlowSignsInAndSetsSecureSession(t *testing.T) {
	h := newHarness(t)
	w := h.signIn("client", "/watch/abc")

	assert.Equal(t, http.StatusFound, w.Code)
	assert.Equal(t, clientOrigin+"/watch/abc", w.Header().Get("Location"))
	assert.Nil(t, cookieNamed(w, AdminSessionCookie))
	session := cookieNamed(w, ClientSessionCookie)
	require.NotNil(t, session)
	assert.True(t, session.HttpOnly)
	assert.True(t, session.Secure)
	assert.Equal(t, http.SameSiteLaxMode, session.SameSite)
	cleared := cookieNamed(w, stateCookie)
	require.NotNil(t, cleared)
	assert.Equal(t, -1, cleared.MaxAge, "state cookie is single use")

	resp := h.get("/api/me", clientOrigin, session)
	assert.Equal(t, http.StatusOK, resp.Code)
	assert.Equal(t, "owner@example.com", resp.Body.String())

	page, err := h.audit.List(context.Background(), 10, "", audit.SignIn)
	require.NoError(t, err)
	assert.Len(t, page.Entries, 1)
}

func TestCallbackRejectsForgedOrReplayedState(t *testing.T) {
	h := newHarness(t)
	start := h.do(httptest.NewRequest(http.MethodGet, "/auth/google/start?app=client&next=/", nil))
	state := cookieNamed(start, stateCookie)
	require.True(t, strings.HasPrefix(h.provider.state, "client."), "state names the app")

	cases := map[string]func(r *http.Request){
		"no cookie":       func(r *http.Request) {},
		"tampered cookie": func(r *http.Request) { r.AddCookie(&http.Cookie{Name: stateCookie, Value: state.Value + "x"}) },
		"other browser":   func(r *http.Request) { r.AddCookie(&http.Cookie{Name: stateCookie, Value: "a.b"}) },
	}
	for name, prepare := range cases {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/auth/google/callback?code=good-code&state="+h.provider.state, nil)
			prepare(r)
			w := h.do(r)
			assert.Equal(t, http.StatusFound, w.Code)
			assert.Equal(t, clientOrigin+"/login?error=session_expired", w.Header().Get("Location"))
			assert.Nil(t, cookieNamed(w, ClientSessionCookie))
		})
	}

	t.Run("state param mismatch", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/auth/google/callback?code=good-code&state=other", nil)
		r.AddCookie(state)
		w := h.do(r)
		assert.Contains(t, w.Header().Get("Location"), "error=session_expired")
	})

	t.Run("expired state", func(t *testing.T) {
		h.service.now = func() time.Time { return time.Now().Add(flowStateTTL + time.Minute) }
		defer func() { h.service.now = time.Now }()
		r := httptest.NewRequest(http.MethodGet, "/auth/google/callback?code=good-code&state="+h.provider.state, nil)
		r.AddCookie(state)
		w := h.do(r)
		assert.Contains(t, w.Header().Get("Location"), "error=session_expired")
	})
}

func TestUninvitedAccountIsSentBackWithReason(t *testing.T) {
	h := newHarness(t)
	h.provider.identity = accounts.Identity{Subject: "s", Email: "stranger@example.com", EmailVerified: true}
	w := h.signIn("client", "/videos")

	assert.Equal(t, clientOrigin+"/login?error=not_invited&next=%2Fvideos", w.Header().Get("Location"))
	assert.Nil(t, cookieNamed(w, ClientSessionCookie))

	page, err := h.audit.List(context.Background(), 10, "", audit.SignInRefused)
	require.NoError(t, err)
	require.Len(t, page.Entries, 1)
	assert.Equal(t, "not_invited", page.Entries[0].Detail["reason"])
}

func TestClientAppErrorsGoToClientLogin(t *testing.T) {
	h := newHarness(t)
	h.provider.exchangeErr = errors.New("google down")
	w := h.signIn("client", "/watch/abc")
	assert.Equal(t, clientOrigin+"/login?error=google_failed&next=%2Fwatch%2Fabc", w.Header().Get("Location"))
}

func TestUnknownAppFallsBackToClient(t *testing.T) {
	h := newHarness(t)
	w := h.signIn("https://evil.example", "/")
	assert.Equal(t, clientOrigin+"/", w.Header().Get("Location"))
}

func TestOpenRedirectsAreNeutralized(t *testing.T) {
	for _, next := range []string{"https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/ok\r\nSet-Cookie: x"} {
		assert.Equal(t, "/", SafeNext(next), next)
	}
	assert.Equal(t, "/users?x=1", SafeNext("/users?x=1"))

	h := newHarness(t)
	w := h.signIn("client", "//evil.example")
	assert.Equal(t, clientOrigin+"/", w.Header().Get("Location"))
}

func TestSuperuserGateAndOriginCheck(t *testing.T) {
	h := passwordHarness(t)
	ctx := context.Background()
	ownerSession := h.adminSession()
	owner, _, err := h.store.SessionUser(ctx, ownerSession.Value, config.AppAdmin)
	require.NoError(t, err)
	ownerGoogle := cookieNamed(h.signIn("client", "/"), ClientSessionCookie)
	require.NotNil(t, ownerGoogle)

	_, err = h.store.CreateInvite(ctx, owner, "member@example.com")
	require.NoError(t, err)
	h.provider.identity = accounts.Identity{Subject: "m", Email: "member@example.com", EmailVerified: true}
	memberSession := cookieNamed(h.signIn("client", "/"), ClientSessionCookie)
	// The same token under the admin cookie name still isn't an admin session.
	memberAsAdmin := &http.Cookie{Name: AdminSessionCookie, Value: memberSession.Value}
	ownerGoogleAsAdmin := &http.Cookie{Name: AdminSessionCookie, Value: ownerGoogle.Value}

	post := func(session *http.Cookie, origin string) int {
		r := httptest.NewRequest(http.MethodPost, "/api/admin/thing", nil)
		if session != nil {
			r.AddCookie(session)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return h.do(r).Code
	}

	assert.Equal(t, http.StatusUnauthorized, post(nil, adminOrigin))
	assert.Equal(t, http.StatusUnauthorized, post(memberSession, adminOrigin), "client cookies aren't read by the admin portal")
	assert.Equal(t, http.StatusUnauthorized, post(memberAsAdmin, adminOrigin), "a client session is no admin session")
	assert.Equal(t, http.StatusUnauthorized, post(ownerGoogleAsAdmin, adminOrigin), "not even the owner's Google session")
	assert.Equal(t, http.StatusForbidden, post(ownerGoogle, clientOrigin), "the admin API ignores the client portal")
	assert.Equal(t, http.StatusUnauthorized, post(ownerSession, "https://evil.example"), "cross-site writes refused (the admin session is only read from the admin portal)")
	assert.Equal(t, http.StatusUnauthorized, post(ownerSession, ""), "writes need an Origin (the admin session is only read from the admin portal)")
	assert.Equal(t, http.StatusUnauthorized, post(ownerSession, clientOrigin), "admin writes only from the admin portal (the admin session is only read from the admin portal)")
	assert.Equal(t, http.StatusUnauthorized, post(ownerSession, apiOrigin), "the API host isn't a portal (the admin session is only read from the admin portal)")
	assert.Equal(t, http.StatusNoContent, post(ownerSession, adminOrigin))
}

func TestLogoutEndsSessionAndNeedsSameOrigin(t *testing.T) {
	h := newHarness(t)
	session := cookieNamed(h.signIn("client", "/"), ClientSessionCookie)

	crossSite := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	crossSite.AddCookie(session)
	crossSite.Header.Set("Origin", "https://evil.example")
	assert.Equal(t, http.StatusForbidden, h.do(crossSite).Code)

	logout := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	logout.AddCookie(session)
	logout.Header.Set("Origin", clientOrigin)
	w := h.do(logout)
	assert.Equal(t, http.StatusNoContent, w.Code)

	resp := h.get("/api/me", clientOrigin, session)
	assert.Equal(t, http.StatusUnauthorized, resp.Code)
	cleared := cookieNamed(resp, ClientSessionCookie)
	require.NotNil(t, cleared, "a dead session cookie is cleared")
	assert.Equal(t, -1, cleared.MaxAge)
}

func TestDevLoginIsOffUnlessConfigured(t *testing.T) {
	h := newHarness(t)
	r := httptest.NewRequest(http.MethodPost, "/auth/password", strings.NewReader(`{"email":"owner@example.com"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", adminOrigin)
	assert.Equal(t, http.StatusNotFound, h.do(r).Code, "route isn't registered")
}

func devHarness(t *testing.T) *harness {
	return newHarness(t, func(cfg *config.Config) {
		cfg.Env = config.EnvDevelopment
		cfg.DevLogin = true
		cfg.DevPassword = "local-password-123"
	})
}

func (h *harness) devLogin(origin, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/auth/password", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return h.do(r)
}

func TestDevLoginNeedsTheLocalPassword(t *testing.T) {
	h := devHarness(t)

	wrong := h.devLogin(adminOrigin, `{"email":"owner@example.com","password":"guess"}`)
	assert.Equal(t, http.StatusUnauthorized, wrong.Code)
	assert.Nil(t, cookieNamed(wrong, AdminSessionCookie))

	missing := h.devLogin(adminOrigin, `{"email":"owner@example.com"}`)
	assert.Equal(t, http.StatusUnauthorized, missing.Code)

	page, err := h.audit.List(context.Background(), 10, "", audit.SignInRefused)
	require.NoError(t, err)
	assert.Len(t, page.Entries, 2, "failed passwords are audited")

	ok := h.devLogin(adminOrigin, `{"email":"Owner@Example.com","password":"local-password-123"}`)
	assert.Equal(t, http.StatusOK, ok.Code)
	assert.NotNil(t, cookieNamed(ok, AdminSessionCookie))
}

func TestDevLoginStillAppliesTheAllowlistAndOrigin(t *testing.T) {
	h := devHarness(t)

	stranger := h.devLogin(adminOrigin, `{"email":"stranger@example.com","password":"local-password-123"}`)
	assert.Equal(t, http.StatusForbidden, stranger.Code)

	crossSite := h.devLogin("https://evil.example", `{"email":"owner@example.com","password":"local-password-123"}`)
	assert.Equal(t, http.StatusForbidden, crossSite.Code)

	noOrigin := h.devLogin("", `{"email":"owner@example.com","password":"local-password-123"}`)
	assert.Equal(t, http.StatusForbidden, noOrigin.Code)
}

func TestMethodsOfferOneMethodPerPortal(t *testing.T) {
	for _, h := range []*harness{passwordHarness(t), devHarness(t)} {
		assert.JSONEq(t, `{"google":false,"password":true}`, h.get("/auth/methods", adminOrigin, nil).Body.String(), "admin: password only")
		assert.JSONEq(t, `{"google":true,"password":false}`, h.get("/auth/methods", clientOrigin, nil).Body.String(), "client: Google only")
		assert.JSONEq(t, `{"google":false,"password":true}`, h.get("/auth/methods?app=admin", "", nil).Body.String())
		assert.JSONEq(t, `{"google":true,"password":false}`, h.get("/auth/methods", "", nil).Body.String())
	}
}

func TestAdminPortalCannotUseGoogle(t *testing.T) {
	h := passwordHarness(t)
	start := h.do(httptest.NewRequest(http.MethodGet, "/auth/google/start?app=admin&next=/users", nil))
	assert.Equal(t, http.StatusFound, start.Code)
	assert.Equal(t, adminOrigin+"/login?error=method_not_allowed&next=%2Fusers", start.Header().Get("Location"))
	assert.Nil(t, cookieNamed(start, stateCookie), "no Google flow starts")
	assert.Empty(t, h.provider.state)
}

func TestClientPortalCannotUsePassword(t *testing.T) {
	h := passwordHarness(t)
	_, err := h.store.SetPassword(context.Background(), "owner@example.com", "owner-password")
	require.NoError(t, err)
	w := h.devLogin(clientOrigin, `{"email":"owner@example.com","password":"owner-password"}`)
	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "method_not_allowed")
	assert.Nil(t, cookieNamed(w, AdminSessionCookie))
	assert.Nil(t, cookieNamed(w, ClientSessionCookie))
}

func TestPortalsKeepSeparateSessions(t *testing.T) {
	h := passwordHarness(t)
	admin := h.adminSession()
	client := cookieNamed(h.signIn("client", "/"), ClientSessionCookie)

	assert.Equal(t, "owner@example.com", h.get("/api/me", adminOrigin, admin).Body.String())
	assert.Equal(t, "owner@example.com", h.get("/api/me", clientOrigin, client).Body.String())
	assert.Equal(t, http.StatusUnauthorized, h.get("/api/me", clientOrigin, admin).Code, "admin cookie unused by the client portal")
	assert.Equal(t, http.StatusUnauthorized, h.get("/api/me", adminOrigin, client).Code, "client cookie unused by the admin portal")
	assert.Equal(t, http.StatusUnauthorized, h.get("/api/me", "", admin).Code, "no portal, no session")

	logout := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	logout.Header.Set("Origin", clientOrigin)
	logout.AddCookie(client)
	require.Equal(t, http.StatusNoContent, h.do(logout).Code)
	assert.Equal(t, http.StatusOK, h.get("/api/me", adminOrigin, admin).Code, "signing out of the client leaves admin signed in")
}

func TestSignInIsRateLimited(t *testing.T) {
	h := newHarness(t)
	var last int
	for i := 0; i < 21; i++ {
		last = h.do(httptest.NewRequest(http.MethodGet, "/auth/google/start", nil)).Code
	}
	assert.Equal(t, http.StatusTooManyRequests, last)
}

func TestProductionPasswordSignIn(t *testing.T) {
	h := passwordHarness(t)
	_, err := h.store.SetPassword(context.Background(), "owner@example.com", "owner-password")
	require.NoError(t, err)

	wrong := h.devLogin(adminOrigin, `{"email":"owner@example.com","password":"guess-guess"}`)
	assert.Equal(t, http.StatusUnauthorized, wrong.Code)
	assert.Nil(t, cookieNamed(wrong, AdminSessionCookie))

	cross := h.devLogin("https://evil.example", `{"email":"owner@example.com","password":"owner-password"}`)
	assert.Equal(t, http.StatusForbidden, cross.Code, "other sites can't sign anyone in")

	ok := h.devLogin(adminOrigin, `{"email":"Owner@Example.com","password":"owner-password"}`)
	require.Equal(t, http.StatusOK, ok.Code, ok.Body.String())
	session := cookieNamed(ok, AdminSessionCookie)
	require.NotNil(t, session)
	assert.True(t, session.HttpOnly)
	assert.True(t, session.Secure)

	assert.Equal(t, "owner@example.com", h.get("/api/me", adminOrigin, session).Body.String())
}

func TestPasswordSignInLocksOutAfterRepeatedFailures(t *testing.T) {
	h := passwordHarness(t)
	_, err := h.store.SetPassword(context.Background(), "owner@example.com", "owner-password")
	require.NoError(t, err)
	for i := 0; i < 10; i++ {
		r := h.devLogin(adminOrigin, `{"email":"owner@example.com","password":"nope-nope"}`)
		require.Equal(t, http.StatusUnauthorized, r.Code)
	}
	locked := h.devLogin(adminOrigin, `{"email":"owner@example.com","password":"owner-password"}`)
	assert.Equal(t, http.StatusTooManyRequests, locked.Code, "even the right password waits once locked")
}

func TestPasswordRouteOffWithoutPasswordLogin(t *testing.T) {
	h := newHarness(t)
	assert.JSONEq(t, `{"google":false,"password":false}`, h.get("/auth/methods", adminOrigin, nil).Body.String())
}
