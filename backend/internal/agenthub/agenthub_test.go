package agenthub

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

type fixture struct {
	hub    *Hub
	server *httptest.Server
	owner  accounts.User
	audit  *audit.Log
}

func setup(t *testing.T) *fixture {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })
	_, err = database.Exec(`INSERT INTO users (id, email, role) VALUES ('u1', 'owner@example.com', 'superuser')`)
	require.NoError(t, err)

	auditLog := audit.New(database)
	hub := New(database, auditLog, false)
	mux := http.NewServeMux()
	hub.Routes(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(func() {
		hub.Close()
		server.Close()
	})
	return &fixture{hub: hub, server: server, audit: auditLog,
		owner: accounts.User{ID: "u1", Email: "owner@example.com"}}
}

func (f *fixture) pair(t *testing.T, code string, header http.Header) (*http.Response, agentproto.PairResponse) {
	t.Helper()
	body, _ := json.Marshal(agentproto.PairRequest{Code: code, Name: "Studio\x00 Mac", Hostname: "studio.local"})
	req, _ := http.NewRequest(http.MethodPost, f.server.URL+agentproto.PairPath, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for key, values := range header {
		req.Header[key] = values
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out agentproto.PairResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func (f *fixture) dial(t *testing.T, token string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.server.URL, "http")+agentproto.ConnectPath,
		&websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
}

func eventually(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatal("condition never became true")
		}
		runtimeGosched()
	}
}

func TestPairConnectAndRevoke(t *testing.T) {
	f := setup(t)
	ctx := context.Background()

	code, err := f.hub.CreatePairingCode(ctx, f.owner, "127.0.0.1")
	require.NoError(t, err)
	assert.Regexp(t, `^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$`, code.Code)

	// Lower case and no dash still match; the name is cleaned.
	resp, paired := f.pair(t, strings.ToLower(strings.ReplaceAll(code.Code, "-", "")), nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.True(t, strings.HasPrefix(paired.Token, agentproto.TokenPrefix))
	assert.Equal(t, "Studio Mac", paired.Name)

	again, _ := f.pair(t, code.Code, nil)
	assert.Equal(t, http.StatusUnauthorized, again.StatusCode, "codes are single use")

	conn, _, err := f.dial(t, paired.Token)
	require.NoError(t, err)
	defer conn.CloseNow()
	var welcome agentproto.Message
	require.NoError(t, wsjson.Read(ctx, conn, &welcome))
	assert.Equal(t, agentproto.TypeWelcome, welcome.Type)
	assert.Equal(t, paired.DeviceID, welcome.DeviceID)

	require.NoError(t, wsjson.Write(ctx, conn, agentproto.Message{Type: agentproto.TypeHello, Capabilities: &agentproto.Capabilities{
		AgentVersion: "1.0", Hostname: "studio.local", OS: "darwin", Arch: "arm64",
		Engines: []agentproto.Engine{{ID: "parakeet", Name: "Parakeet", Ready: true}},
		Tools:   map[string]bool{"ffmpeg": true},
	}}))

	eventually(t, func() bool {
		devices, err := f.hub.ListDevices(ctx)
		return err == nil && len(devices) == 1 && devices[0].Online && devices[0].Capabilities != nil
	})
	devices, _ := f.hub.ListDevices(ctx)
	assert.Equal(t, "darwin/arm64", devices[0].Platform)
	assert.True(t, devices[0].Capabilities.Engines[0].Ready)
	assert.Equal(t, "owner@example.com", *devices[0].PairedBy)

	require.NoError(t, f.hub.Revoke(ctx, f.owner, paired.DeviceID, "127.0.0.1"))
	_, _, err = conn.Read(ctx)
	assert.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err), "revoking drops the connection")

	_, resp, err = f.dial(t, paired.Token)
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, "a revoked token can't reconnect")
	devices, _ = f.hub.ListDevices(ctx)
	assert.Empty(t, devices)
	assert.ErrorIs(t, f.hub.Revoke(ctx, f.owner, paired.DeviceID, ""), ErrNotFound)
}

func TestPairingRefusals(t *testing.T) {
	f := setup(t)
	ctx := context.Background()

	resp, _ := f.pair(t, "WRNG-CODE", nil)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	code, err := f.hub.CreatePairingCode(ctx, f.owner, "")
	require.NoError(t, err)
	browser, _ := f.pair(t, code.Code, http.Header{"Origin": {"https://evil.example"}})
	assert.Equal(t, http.StatusForbidden, browser.StatusCode, "browsers can't pair")

	f.hub.now = func() time.Time { return time.Now().Add(PairingCodeTTL + time.Minute) }
	expired, _ := f.pair(t, code.Code, nil)
	assert.Equal(t, http.StatusUnauthorized, expired.StatusCode, "codes expire")

	page, err := f.audit.List(ctx, 10, "", audit.DevicePairRefused)
	require.NoError(t, err)
	assert.Len(t, page.Entries, 2)
}

func TestConnectRefusals(t *testing.T) {
	f := setup(t)
	_, resp, err := f.dial(t, "vd_dev_not-a-real-token")
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err = websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.server.URL, "http")+agentproto.ConnectPath,
		&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://evil.example"}, "Authorization": {"Bearer vd_dev_x"}}})
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode, "browsers can't connect")
}

func TestCleanAndSanitize(t *testing.T) {
	assert.Equal(t, "abc", clean("  a\x1bb\nc ", 10))
	assert.Equal(t, "ab", clean("abc", 2))
	caps := sanitize(&agentproto.Capabilities{OS: strings.Repeat("x", 100), Engines: make([]agentproto.Engine, 20)})
	assert.Len(t, caps.OS, 30)
	assert.Len(t, caps.Engines, 8)
}

func runtimeGosched() { runtime.Gosched() }

func TestInstallEngineRoundTrip(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	code, err := f.hub.CreatePairingCode(ctx, f.owner, "")
	require.NoError(t, err)
	_, paired := f.pair(t, code.Code, nil)

	assert.ErrorIs(t, f.hub.InstallEngine(ctx, f.owner, paired.DeviceID, "whisper", ""), ErrOffline)
	assert.ErrorIs(t, f.hub.InstallEngine(ctx, f.owner, "nope", "whisper", ""), ErrNotFound)

	conn, _, err := f.dial(t, paired.Token)
	require.NoError(t, err)
	defer conn.CloseNow()
	var welcome agentproto.Message
	require.NoError(t, wsjson.Read(ctx, conn, &welcome))
	eventually(t, func() bool { return f.hub.OnlineCount() == 1 })

	assert.ErrorIs(t, f.hub.InstallEngine(ctx, f.owner, paired.DeviceID, "rm -rf", ""), ErrUnknownEngine)
	require.NoError(t, f.hub.InstallEngine(ctx, f.owner, paired.DeviceID, "whisper", ""))

	var request agentproto.Message
	require.NoError(t, wsjson.Read(ctx, conn, &request))
	assert.Equal(t, agentproto.Message{Type: agentproto.TypeInstall, Engine: "whisper"}, request)

	require.NoError(t, wsjson.Write(ctx, conn, agentproto.Message{Type: agentproto.TypeInstallStatus,
		Engine: "whisper", State: agentproto.InstallReady, Detail: "model downloaded"}))
	eventually(t, func() bool {
		devices, _ := f.hub.ListDevices(ctx)
		return len(devices) == 1 && devices[0].Installs["whisper"].State == agentproto.InstallReady
	})
}
