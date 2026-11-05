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

const origin = "https://vidura.example.com"

func newHarness(t *testing.T) *harness {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })

	publicURL, _ := url.Parse(origin)
	cfg := &config.Config{
		Env:             config.EnvProduction,
		PublicURL:       publicURL,
		Secret:          []byte(strings.Repeat("k", 32)),
		SuperuserEmails: map[string]bool{"owner@example.com": true},
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
	mux.HandleFunc("POST /admin/api/thing", service.RequireSuperuser(func(w http.ResponseWriter, r *http.Request) {
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

// signIn runs the whole Google flow and returns the callback response.
func (h *harness) signIn(next string) *httptest.ResponseRecorder {
	start := h.do(httptest.NewRequest(http.MethodGet, "/auth/google/start?next="+url.QueryEscape(next), nil))
	require.Equal(h.t, http.StatusFound, start.Code)
	state := cookieNamed(start, stateCookie)
	require.NotNil(h.t, state)

	callback := httptest.NewRequest(http.MethodGet,
		"/auth/google/callback?code=good-code&state="+url.QueryEscape(h.provider.state), nil)
	callback.AddCookie(state)
	return h.do(callback)
}

func TestGoogleFlowSignsInAndSetsSecureSession(t *testing.T) {
	h := newHarness(t)
	w := h.signIn("/admin/users")

	assert.Equal(t, http.StatusFound, w.Code)
	assert.Equal(t, "/admin/users", w.Header().Get("Location"))
	session := cookieNamed(w, SessionCookie)
	require.NotNil(t, session)
	assert.True(t, session.HttpOnly)
	assert.True(t, session.Secure)
	assert.Equal(t, http.SameSiteLaxMode, session.SameSite)
	cleared := cookieNamed(w, stateCookie)
	require.NotNil(t, cleared)
	assert.Equal(t, -1, cleared.MaxAge, "state cookie is single use")

	me := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	me.AddCookie(session)
	resp := h.do(me)
	assert.Equal(t, http.StatusOK, resp.Code)
	assert.Equal(t, "owner@example.com", resp.Body.String())

	page, err := h.audit.List(context.Background(), 10, "", audit.SignIn)
	require.NoError(t, err)
	assert.Len(t, page.Entries, 1)
}

func TestCallbackRejectsForgedOrReplayedState(t *testing.T) {
	h := newHarness(t)
	start := h.do(httptest.NewRequest(http.MethodGet, "/auth/google/start?next=/admin", nil))
	state := cookieNamed(start, stateCookie)

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
			assert.Contains(t, w.Header().Get("Location"), "error=session_expired")
			assert.Nil(t, cookieNamed(w, SessionCookie))
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
	w := h.signIn("/admin")

	assert.Equal(t, "/admin/login?error=not_invited&next=%2Fadmin", w.Header().Get("Location"))
	assert.Nil(t, cookieNamed(w, SessionCookie))

	page, err := h.audit.List(context.Background(), 10, "", audit.SignInRefused)
	require.NoError(t, err)
	require.Len(t, page.Entries, 1)
	assert.Equal(t, "not_invited", page.Entries[0].Detail["reason"])
}

func TestClientAppErrorsGoToClientLogin(t *testing.T) {
	h := newHarness(t)
	h.provider.exchangeErr = errors.New("google down")
	w := h.signIn("/watch/abc")
	assert.Equal(t, "/login?error=google_failed&next=%2Fwatch%2Fabc", w.Header().Get("Location"))
}

func TestOpenRedirectsAreNeutralized(t *testing.T) {
	for _, next := range []string{"https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/ok\r\nSet-Cookie: x"} {
		assert.Equal(t, "/", SafeNext(next), next)
	}
	assert.Equal(t, "/admin/users?x=1", SafeNext("/admin/users?x=1"))

	h := newHarness(t)
	w := h.signIn("//evil.example")
	assert.Equal(t, "/", w.Header().Get("Location"))
}

func TestSuperuserGateAndOriginCheck(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	ownerSession := cookieNamed(h.signIn("/admin"), SessionCookie)
	owner, _, err := h.store.SessionUser(ctx, ownerSession.Value)
	require.NoError(t, err)

	_, err = h.store.CreateInvite(ctx, owner, "member@example.com")
	require.NoError(t, err)
	h.provider.identity = accounts.Identity{Subject: "m", Email: "member@example.com", EmailVerified: true}
	memberSession := cookieNamed(h.signIn("/"), SessionCookie)

	post := func(session *http.Cookie, origin string) int {
		r := httptest.NewRequest(http.MethodPost, "/admin/api/thing", nil)
		if session != nil {
			r.AddCookie(session)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return h.do(r).Code
	}

	assert.Equal(t, http.StatusUnauthorized, post(nil, origin))
	assert.Equal(t, http.StatusForbidden, post(memberSession, origin), "members can't use the admin API")
	assert.Equal(t, http.StatusForbidden, post(ownerSession, "https://evil.example"), "cross-site writes refused")
	assert.Equal(t, http.StatusForbidden, post(ownerSession, ""), "writes need an Origin")
	assert.Equal(t, http.StatusNoContent, post(ownerSession, origin))
}

func TestLogoutEndsSessionAndNeedsSameOrigin(t *testing.T) {
	h := newHarness(t)
	session := cookieNamed(h.signIn("/"), SessionCookie)

	crossSite := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	crossSite.AddCookie(session)
	crossSite.Header.Set("Origin", "https://evil.example")
	assert.Equal(t, http.StatusForbidden, h.do(crossSite).Code)

	logout := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	logout.AddCookie(session)
	logout.Header.Set("Origin", origin)
	w := h.do(logout)
	assert.Equal(t, http.StatusNoContent, w.Code)

	me := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	me.AddCookie(session)
	resp := h.do(me)
	assert.Equal(t, http.StatusUnauthorized, resp.Code)
	cleared := cookieNamed(resp, SessionCookie)
	require.NotNil(t, cleared, "a dead session cookie is cleared")
	assert.Equal(t, -1, cleared.MaxAge)
}

func TestDevLoginIsOffUnlessConfigured(t *testing.T) {
	h := newHarness(t)
	r := httptest.NewRequest(http.MethodPost, "/auth/dev-login", strings.NewReader(`{"email":"owner@example.com"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", origin)
	assert.Equal(t, http.StatusNotFound, h.do(r).Code, "route isn't registered")
}

func TestSignInIsRateLimited(t *testing.T) {
	h := newHarness(t)
	var last int
	for i := 0; i < 21; i++ {
		last = h.do(httptest.NewRequest(http.MethodGet, "/auth/google/start", nil)).Code
	}
	assert.Equal(t, http.StatusTooManyRequests, last)
}
