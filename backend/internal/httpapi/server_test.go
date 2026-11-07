package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

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

type env struct {
	t      *testing.T
	server *Server
	store  *accounts.Store
	owner  accounts.User
	// ownerCookie is the owner's session cookie.
	ownerCookie *http.Cookie
}

func newEnv(t *testing.T, adminUI fstest.MapFS, options ...func(*Deps)) *env {
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
	store := accounts.NewStore(database, cfg)
	auditLog := audit.New(database)
	deps := Deps{
		Config: cfg, DB: database, Accounts: store, Audit: auditLog,
		Auth: auth.NewService(cfg, store, auditLog, nil), Version: "test",
	}
	if adminUI != nil {
		deps.AdminUI = adminUI
	}
	for _, option := range options {
		option(&deps)
	}
	e := &env{t: t, server: New(deps), store: store}
	e.owner, e.ownerCookie = e.signIn("owner-sub", "owner@example.com")
	return e
}

func (e *env) signIn(sub, email string) (accounts.User, *http.Cookie) {
	e.t.Helper()
	user, err := e.store.SignIn(context.Background(), accounts.Identity{Subject: sub, Email: email, EmailVerified: true})
	require.NoError(e.t, err)
	token, _, err := e.store.CreateSession(context.Background(), user.ID, accounts.SessionMeta{App: "admin"})
	require.NoError(e.t, err)
	return user, &http.Cookie{Name: auth.AdminSessionCookie, Value: token}
}

// clientSignIn signs a user in to the client portal (as Google would) and
// returns the client session cookie.
func (e *env) clientSignIn(sub, email string) (accounts.User, *http.Cookie) {
	e.t.Helper()
	user, err := e.store.SignIn(context.Background(), accounts.Identity{Subject: sub, Email: email, EmailVerified: true})
	require.NoError(e.t, err)
	token, _, err := e.store.CreateSession(context.Background(), user.ID, accounts.SessionMeta{App: "client"})
	require.NoError(e.t, err)
	return user, &http.Cookie{Name: auth.ClientSessionCookie, Value: token}
}

// clientCall sends an API request the way the client portal does.
func (e *env) clientCall(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	return e.request(apiOrigin, method, path, body, clientOrigin, cookie)
}

// call sends an API request the way the admin portal does: to the API host,
// cross-origin, so the browser adds the admin portal's Origin to every request.
func (e *env) call(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	return e.request(apiOrigin, method, path, body, adminOrigin, cookie)
}

func (e *env) request(base, method, path, body, origin string, cookie *http.Cookie) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, base+path, reader)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	e.server.ServeHTTP(w, r)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out), w.Body.String())
	return out
}

func TestInviteThenManageMember(t *testing.T) {
	e := newEnv(t, nil)

	created := e.call(http.MethodPost, "/api/admin/invites", `{"email":"Family@Example.com"}`, e.ownerCookie)
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	assert.Equal(t, "family@example.com", decode(t, created)["invite"].(map[string]any)["email"])

	dup := e.call(http.MethodPost, "/api/admin/invites", `{"email":"family@example.com"}`, e.ownerCookie)
	assert.Equal(t, http.StatusConflict, dup.Code)

	member, memberCookie := e.signIn("m-sub", "family@example.com")

	// Members are locked out of the admin API.
	assert.Equal(t, http.StatusForbidden, e.call(http.MethodGet, "/api/admin/users", "", memberCookie).Code)

	users := decode(t, e.call(http.MethodGet, "/api/admin/users", "", e.ownerCookie))["users"].([]any)
	require.Len(t, users, 2)
	ownerRow := users[0].(map[string]any)
	assert.Equal(t, true, ownerRow["owner"])
	assert.EqualValues(t, 1, ownerRow["activeSessions"])

	promoted := e.call(http.MethodPatch, "/api/admin/users/"+member.ID, `{"role":"superuser"}`, e.ownerCookie)
	require.Equal(t, http.StatusOK, promoted.Code, promoted.Body.String())
	assert.Equal(t, "superuser", decode(t, promoted)["user"].(map[string]any)["role"])

	self := e.call(http.MethodPatch, "/api/admin/users/"+e.owner.ID, `{"status":"disabled"}`, e.ownerCookie)
	assert.Equal(t, http.StatusForbidden, self.Code)
	assert.Equal(t, "You can't change your own account.", decode(t, self)["error"].(map[string]any)["message"])

	empty := e.call(http.MethodPatch, "/api/admin/users/"+member.ID, `{}`, e.ownerCookie)
	assert.Equal(t, http.StatusBadRequest, empty.Code)

	injected := e.call(http.MethodPatch, "/api/admin/users/"+member.ID, `{"role":"member","email":"x@y.z"}`, e.ownerCookie)
	assert.Equal(t, http.StatusBadRequest, injected.Code, "unknown fields are rejected")

	disabled := e.call(http.MethodPatch, "/api/admin/users/"+member.ID, `{"status":"disabled"}`, e.ownerCookie)
	require.Equal(t, http.StatusOK, disabled.Code)
	assert.Equal(t, http.StatusUnauthorized, e.call(http.MethodGet, "/api/me", "", memberCookie).Code,
		"disabling ends the member's sessions")

	assert.Equal(t, http.StatusNoContent, e.call(http.MethodDelete, "/api/admin/users/"+member.ID, "", e.ownerCookie).Code)
	assert.Equal(t, http.StatusNotFound, e.call(http.MethodDelete, "/api/admin/users/"+member.ID, "", e.ownerCookie).Code)

	audit := decode(t, e.call(http.MethodGet, "/api/admin/audit?limit=50", "", e.ownerCookie))
	var actions []string
	for _, entry := range audit["entries"].([]any) {
		actions = append(actions, entry.(map[string]any)["action"].(string))
	}
	assert.Equal(t, []string{"user.deleted", "user.updated", "user.updated", "invite.created"}, actions)

	overview := decode(t, e.call(http.MethodGet, "/api/admin/overview", "", e.ownerCookie))
	accountsBlock := overview["accounts"].(map[string]any)
	assert.EqualValues(t, 1, accountsBlock["users"])
	assert.EqualValues(t, 0, accountsBlock["pendingInvites"], "deleting the member removed their invite")
}

func TestInviteDeleteEscapesEmail(t *testing.T) {
	e := newEnv(t, nil)
	require.Equal(t, http.StatusCreated, e.call(http.MethodPost, "/api/admin/invites", `{"email":"a+b@example.com"}`, e.ownerCookie).Code)
	assert.Equal(t, http.StatusNoContent, e.call(http.MethodDelete, "/api/admin/invites/"+url.PathEscape("a+b@example.com"), "", e.ownerCookie).Code)
	assert.Equal(t, http.StatusNotFound, e.call(http.MethodDelete, "/api/admin/invites/a+b@example.com", "", e.ownerCookie).Code)
}

func TestMeAndUnknownEndpoints(t *testing.T) {
	e := newEnv(t, nil)
	me := e.call(http.MethodGet, "/api/me", "", e.ownerCookie)
	require.Equal(t, http.StatusOK, me.Code)
	assert.Equal(t, "owner@example.com", decode(t, me)["user"].(map[string]any)["email"])
	assert.Equal(t, http.StatusUnauthorized, e.call(http.MethodGet, "/api/me", "", nil).Code)

	missing := e.call(http.MethodGet, "/api/nope", "", nil)
	assert.Equal(t, http.StatusNotFound, missing.Code)
	assert.Equal(t, "application/json; charset=utf-8", missing.Header().Get("Content-Type"))
	assert.Equal(t, apiCSP, missing.Header().Get("Content-Security-Policy"))
	assert.Equal(t, "nosniff", missing.Header().Get("X-Content-Type-Options"))
	assert.NotEmpty(t, missing.Header().Get("Strict-Transport-Security"))
}

func TestAdminPortalIsServedOnItsOwnHost(t *testing.T) {
	e := newEnv(t, fstest.MapFS{
		"index.html":        {Data: []byte(`<meta name="vidura-api-url" content="__VIDURA_API_URL__">`)},
		"assets/app-abc.js": {Data: []byte("console.log(1)")},
		"vidura-icon.svg":   {Data: []byte("<svg/>")},
	})
	get := func(path string) *httptest.ResponseRecorder {
		return e.request(adminOrigin, http.MethodGet, path, "", "", nil)
	}

	shell := get("/users/123")
	assert.Equal(t, http.StatusOK, shell.Code)
	assert.Equal(t, `<meta name="vidura-api-url" content="https://api-vidura.example.com">`, shell.Body.String(),
		"the API address is filled in when served")
	assert.Equal(t, "no-cache", shell.Header().Get("Cache-Control"))
	assert.Equal(t, adminCSP(apiOrigin), shell.Header().Get("Content-Security-Policy"))
	assert.Equal(t, "strict-origin-when-cross-origin", shell.Header().Get("Referrer-Policy"), "YouTube previews need a Referer")
	assert.Contains(t, shell.Header().Get("Content-Security-Policy"), "connect-src 'self' https://api-vidura.example.com;")

	asset := get("/assets/app-abc.js")
	assert.Equal(t, http.StatusOK, asset.Code)
	assert.Contains(t, asset.Header().Get("Cache-Control"), "immutable")

	assert.Equal(t, http.StatusNotFound, get("/assets/missing.js").Code)
	traversal := get("/../../etc/passwd")
	assert.Equal(t, shell.Body.String(), traversal.Body.String(), "path traversal gets the app shell, never a file")
	assert.NotContains(t, traversal.Body.String(), "root:")

	// The admin host never answers API routes, and the API host never
	// serves the portal.
	assert.NotContains(t, get("/api/me").Header().Get("Content-Type"), "json")
	assert.Equal(t, http.StatusNotFound, e.request(apiOrigin, http.MethodGet, "/users", "", "", nil).Code)
}

func TestAdminSPAMissingBuild(t *testing.T) {
	e := newEnv(t, nil)
	w := e.request(adminOrigin, http.MethodGet, "/", "", "", nil)
	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
}

func TestClientPortalIsServedOnItsOwnHost(t *testing.T) {
	e := newEnv(t, nil, func(d *Deps) {
		d.ClientUI = fstest.MapFS{
			"index.html": {Data: []byte(`<meta name="vidura-api-url" content="__VIDURA_API_URL__">`)},
			"sw.js":      {Data: []byte("self.skipWaiting()")},
		}
	})
	shell := e.request(clientOrigin, http.MethodGet, "/watch/abc", "", "", nil)
	assert.Equal(t, http.StatusOK, shell.Code)
	assert.Contains(t, shell.Body.String(), `content="https://api-vidura.example.com"`)
	policy := shell.Header().Get("Content-Security-Policy")
	assert.Equal(t, clientCSP(apiOrigin), policy)
	assert.Contains(t, policy, "script-src 'self' https://www.youtube.com https://s.ytimg.com;", "the YouTube player API")
	assert.Contains(t, policy, "frame-src https://www.youtube.com https://www.youtube-nocookie.com;")
	assert.NotContains(t, adminCSP(apiOrigin), "https://www.youtube.com ", "only the client loads YouTube's script")
	assert.Equal(t, "strict-origin-when-cross-origin", shell.Header().Get("Referrer-Policy"))
	assert.Contains(t, shell.Header().Get("Permissions-Policy"), "microphone=(self)", "voice questions")

	sw := e.request(clientOrigin, http.MethodGet, "/sw.js", "", "", nil)
	assert.Equal(t, "no-cache", sw.Header().Get("Cache-Control"), "a new service worker is picked up at once")

	// The client host serves the portal, never the API.
	assert.NotContains(t, e.request(clientOrigin, http.MethodGet, "/api/me", "", "", e.ownerCookie).Header().Get("Content-Type"), "json")
}

func TestClientSPAMissingBuild(t *testing.T) {
	e := newEnv(t, nil)
	assert.Equal(t, http.StatusServiceUnavailable, e.request(clientOrigin, http.MethodGet, "/", "", "", nil).Code)
}

func TestCORSAllowsOnlyThePortals(t *testing.T) {
	e := newEnv(t, nil)
	preflight := func(origin, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodOptions, apiOrigin+path, nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("Access-Control-Request-Method", http.MethodPatch)
		r.Header.Set("Access-Control-Request-Headers", "content-type")
		w := httptest.NewRecorder()
		e.server.ServeHTTP(w, r)
		return w
	}

	ok := preflight(adminOrigin, "/api/admin/users/x")
	assert.Equal(t, http.StatusNoContent, ok.Code)
	assert.Equal(t, adminOrigin, ok.Header().Get("Access-Control-Allow-Origin"))
	assert.Equal(t, "true", ok.Header().Get("Access-Control-Allow-Credentials"))
	assert.Contains(t, ok.Header().Get("Access-Control-Allow-Methods"), "PATCH")

	assert.Equal(t, http.StatusNoContent, preflight(clientOrigin, "/api/me").Code)

	for name, w := range map[string]*httptest.ResponseRecorder{
		"other site":                   preflight("https://evil.example", "/api/me"),
		"client calling the admin API": preflight(clientOrigin, "/api/admin/users"),
	} {
		assert.Equal(t, http.StatusForbidden, w.Code, name)
		assert.Empty(t, w.Header().Get("Access-Control-Allow-Origin"), name)
	}

	// A simple GET from the client portal can't read the admin API.
	read := e.request(apiOrigin, http.MethodGet, "/api/admin/users", "", clientOrigin, e.ownerCookie)
	assert.Empty(t, read.Header().Get("Access-Control-Allow-Origin"))
	me := e.request(apiOrigin, http.MethodGet, "/api/me", "", clientOrigin, e.ownerCookie)
	assert.Equal(t, clientOrigin, me.Header().Get("Access-Control-Allow-Origin"))
}
