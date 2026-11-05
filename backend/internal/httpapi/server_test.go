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

const origin = "https://vidura.example.com"

type env struct {
	t      *testing.T
	server *Server
	store  *accounts.Store
	owner  accounts.User
	// ownerCookie is the owner's session cookie.
	ownerCookie *http.Cookie
}

func newEnv(t *testing.T, adminUI fstest.MapFS) *env {
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
	deps := Deps{
		Config: cfg, DB: database, Accounts: store, Audit: auditLog,
		Auth: auth.NewService(cfg, store, auditLog, nil), Version: "test",
	}
	if adminUI != nil {
		deps.AdminUI = adminUI
	}
	e := &env{t: t, server: New(deps), store: store}
	e.owner, e.ownerCookie = e.signIn("owner-sub", "owner@example.com")
	return e
}

func (e *env) signIn(sub, email string) (accounts.User, *http.Cookie) {
	e.t.Helper()
	user, err := e.store.SignIn(context.Background(), accounts.Identity{Subject: sub, Email: email, EmailVerified: true})
	require.NoError(e.t, err)
	token, _, err := e.store.CreateSession(context.Background(), user.ID, accounts.SessionMeta{})
	require.NoError(e.t, err)
	return user, &http.Cookie{Name: auth.SessionCookie, Value: token}
}

func (e *env) call(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, path, reader)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet {
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

	created := e.call(http.MethodPost, "/admin/api/invites", `{"email":"Family@Example.com"}`, e.ownerCookie)
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	assert.Equal(t, "family@example.com", decode(t, created)["invite"].(map[string]any)["email"])

	dup := e.call(http.MethodPost, "/admin/api/invites", `{"email":"family@example.com"}`, e.ownerCookie)
	assert.Equal(t, http.StatusConflict, dup.Code)

	member, memberCookie := e.signIn("m-sub", "family@example.com")

	// Members are locked out of the admin API.
	assert.Equal(t, http.StatusForbidden, e.call(http.MethodGet, "/admin/api/users", "", memberCookie).Code)

	users := decode(t, e.call(http.MethodGet, "/admin/api/users", "", e.ownerCookie))["users"].([]any)
	require.Len(t, users, 2)
	ownerRow := users[0].(map[string]any)
	assert.Equal(t, true, ownerRow["owner"])
	assert.EqualValues(t, 1, ownerRow["activeSessions"])

	promoted := e.call(http.MethodPatch, "/admin/api/users/"+member.ID, `{"role":"superuser"}`, e.ownerCookie)
	require.Equal(t, http.StatusOK, promoted.Code, promoted.Body.String())
	assert.Equal(t, "superuser", decode(t, promoted)["user"].(map[string]any)["role"])

	self := e.call(http.MethodPatch, "/admin/api/users/"+e.owner.ID, `{"status":"disabled"}`, e.ownerCookie)
	assert.Equal(t, http.StatusForbidden, self.Code)
	assert.Equal(t, "You can't change your own account.", decode(t, self)["error"].(map[string]any)["message"])

	empty := e.call(http.MethodPatch, "/admin/api/users/"+member.ID, `{}`, e.ownerCookie)
	assert.Equal(t, http.StatusBadRequest, empty.Code)

	injected := e.call(http.MethodPatch, "/admin/api/users/"+member.ID, `{"role":"member","email":"x@y.z"}`, e.ownerCookie)
	assert.Equal(t, http.StatusBadRequest, injected.Code, "unknown fields are rejected")

	disabled := e.call(http.MethodPatch, "/admin/api/users/"+member.ID, `{"status":"disabled"}`, e.ownerCookie)
	require.Equal(t, http.StatusOK, disabled.Code)
	assert.Equal(t, http.StatusUnauthorized, e.call(http.MethodGet, "/api/me", "", memberCookie).Code,
		"disabling ends the member's sessions")

	assert.Equal(t, http.StatusNoContent, e.call(http.MethodDelete, "/admin/api/users/"+member.ID, "", e.ownerCookie).Code)
	assert.Equal(t, http.StatusNotFound, e.call(http.MethodDelete, "/admin/api/users/"+member.ID, "", e.ownerCookie).Code)

	audit := decode(t, e.call(http.MethodGet, "/admin/api/audit?limit=50", "", e.ownerCookie))
	var actions []string
	for _, entry := range audit["entries"].([]any) {
		actions = append(actions, entry.(map[string]any)["action"].(string))
	}
	assert.Equal(t, []string{"user.deleted", "user.updated", "user.updated", "invite.created"}, actions)

	overview := decode(t, e.call(http.MethodGet, "/admin/api/overview", "", e.ownerCookie))
	accountsBlock := overview["accounts"].(map[string]any)
	assert.EqualValues(t, 1, accountsBlock["users"])
	assert.EqualValues(t, 0, accountsBlock["pendingInvites"], "deleting the member removed their invite")
}

func TestInviteDeleteEscapesEmail(t *testing.T) {
	e := newEnv(t, nil)
	require.Equal(t, http.StatusCreated, e.call(http.MethodPost, "/admin/api/invites", `{"email":"a+b@example.com"}`, e.ownerCookie).Code)
	assert.Equal(t, http.StatusNoContent, e.call(http.MethodDelete, "/admin/api/invites/"+url.PathEscape("a+b@example.com"), "", e.ownerCookie).Code)
	assert.Equal(t, http.StatusNotFound, e.call(http.MethodDelete, "/admin/api/invites/a+b@example.com", "", e.ownerCookie).Code)
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

func TestAdminSPAServing(t *testing.T) {
	e := newEnv(t, fstest.MapFS{
		"index.html":        {Data: []byte("<html>shell</html>")},
		"assets/app-abc.js": {Data: []byte("console.log(1)")},
		"vidura-icon.svg":   {Data: []byte("<svg/>")},
	})

	shell := e.call(http.MethodGet, "/admin/users/123", "", nil)
	assert.Equal(t, http.StatusOK, shell.Code)
	assert.Equal(t, "<html>shell</html>", shell.Body.String())
	assert.Equal(t, "no-cache", shell.Header().Get("Cache-Control"))
	assert.Equal(t, appCSP, shell.Header().Get("Content-Security-Policy"))

	asset := e.call(http.MethodGet, "/admin/assets/app-abc.js", "", nil)
	assert.Equal(t, http.StatusOK, asset.Code)
	assert.Contains(t, asset.Header().Get("Cache-Control"), "immutable")

	assert.Equal(t, http.StatusNotFound, e.call(http.MethodGet, "/admin/assets/missing.js", "", nil).Code)
	assert.Equal(t, http.StatusMovedPermanently, e.call(http.MethodGet, "/admin", "", nil).Code)
	traversal := e.call(http.MethodGet, "/admin/../../etc/passwd", "", nil)
	assert.NotEqual(t, http.StatusOK, traversal.Code, "path traversal never escapes the embedded files")
	assert.NotContains(t, traversal.Body.String(), "root:")
}

func TestAdminSPAMissingBuild(t *testing.T) {
	e := newEnv(t, nil)
	w := e.call(http.MethodGet, "/admin/", "", nil)
	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
}
