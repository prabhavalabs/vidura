package chatgpt

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeCodex mimics the CLI commands Vidura uses. Device sign-in prints the
// same coloured output as codex 0.166, then blocks reading a FIFO until the
// test "approves" it, and writes auth.json like the real CLI.
const fakeCodex = `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "codex-cli 9.9.9" ;;
  "login status")
    # Like codex 0.166: the message goes to stderr; the exit code tells.
    if [ -f "$CODEX_HOME/auth.json" ]; then echo "Logged in using ChatGPT" >&2; else echo "Not logged in" >&2; exit 1; fi ;;
  "login --device-auth")
    printf 'Welcome to Codex\n\n1. Open this link in your browser and sign in to your account\n   \033[94mhttps://auth.openai.com/codex/device\033[0m\n\n2. Enter this one-time code \033[90m(expires in 15 minutes)\033[0m\n   \033[94mAB12-CD3EF\033[0m\n'
    read answer < "$CODEX_HOME/approve"
    if [ "$answer" = "yes" ]; then cp "$CODEX_HOME/auth.fixture" "$CODEX_HOME/auth.json"; exit 0; fi
    exit 1 ;;
  "logout "*) mv "$CODEX_HOME/auth.json" "$CODEX_HOME/auth.old"; echo "Successfully logged out" ;;
  "debug models") printf '{"models":[{"slug":"hidden","visibility":"hide","priority":0},{"slug":"gpt-b","display_name":"B","visibility":"list","priority":2,"default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},{"slug":"gpt-a","display_name":"A","visibility":"list","priority":1,"default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"medium"}]}]}' ;;
  "exec "*)
    while [ $# -gt 0 ]; do
      if [ "$1" = "--output-last-message" ]; then printf 'ready\n' > "$2"; fi
      shift
    done ;;
esac
`

func newFake(t *testing.T) (*Manager, string, chan string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "codex")
	require.NoError(t, os.WriteFile(bin, []byte(fakeCodex), 0o700))
	home := filepath.Join(dir, "home")

	events := make(chan string, 4)
	m, err := New(home, func(startedBy string, err error) {
		if err != nil {
			events <- startedBy + ":failed"
		} else {
			events <- startedBy + ":ok"
		}
	})
	require.NoError(t, err)
	m.bin = bin

	claims := `{"email":"me@example.com","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}`
	token := "e30." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + ".sig"
	require.NoError(t, os.WriteFile(filepath.Join(home, "auth.fixture"),
		[]byte(`{"tokens":{"id_token":"`+token+`","access_token":"secret","refresh_token":"secret"}}`), 0o600))
	require.NoError(t, syscall.Mkfifo(filepath.Join(home, "approve"), 0o600))
	return m, home, events
}

func approve(t *testing.T, home, answer string) {
	t.Helper()
	fifo, err := os.OpenFile(filepath.Join(home, "approve"), os.O_WRONLY, 0)
	require.NoError(t, err)
	_, err = fifo.WriteString(answer + "\n")
	require.NoError(t, err)
	require.NoError(t, fifo.Close())
}

func waitEvent(t *testing.T, events chan string) string {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(10 * time.Second):
		t.Fatal("sign-in never finished")
		return ""
	}
}

func TestDeviceLoginConnectsAndReportsTheAccount(t *testing.T) {
	m, home, events := newFake(t)
	ctx := context.Background()

	status := m.Status(ctx, true)
	assert.Equal(t, StateNotConnected, status.State)
	assert.Equal(t, CLI{Installed: true, Version: "9.9.9"}, status.CLI)

	login, err := m.StartLogin(ctx, "owner@example.com")
	require.NoError(t, err)
	assert.Equal(t, "https://auth.openai.com/codex/device", login.URL)
	assert.Equal(t, "AB12-CD3EF", login.Code)
	assert.WithinDuration(t, time.Now().Add(15*time.Minute), login.ExpiresAt, 5*time.Second)

	again, err := m.StartLogin(ctx, "owner@example.com")
	require.NoError(t, err)
	assert.Equal(t, login.Code, again.Code, "a sign-in in progress is reused")
	assert.Equal(t, StateConnecting, m.Status(ctx, false).State)

	approve(t, home, "yes")
	assert.Equal(t, "owner@example.com:ok", waitEvent(t, events))

	status = m.Status(ctx, false)
	assert.Equal(t, StateConnected, status.State)
	assert.Nil(t, status.Login)
	assert.Equal(t, &Account{Email: "me@example.com", Plan: "plus"}, status.Account)

	result, err := m.Test(ctx)
	require.NoError(t, err)
	assert.Equal(t, "ready", result.Reply)

	require.NoError(t, m.Logout(ctx))
	assert.Equal(t, StateNotConnected, m.Status(ctx, false).State)
	_, err = m.Test(ctx)
	assert.ErrorIs(t, err, ErrNotConnected)
}

func TestRejectedLoginRecordsAnError(t *testing.T) {
	m, home, events := newFake(t)
	_, err := m.StartLogin(context.Background(), "owner@example.com")
	require.NoError(t, err)
	approve(t, home, "no")
	assert.Equal(t, "owner@example.com:failed", waitEvent(t, events))
	status := m.Status(context.Background(), true)
	assert.Equal(t, StateNotConnected, status.State)
	assert.NotEmpty(t, status.LastError)
}

func TestCancelStopsTheLoginQuietly(t *testing.T) {
	m, _, events := newFake(t)
	_, err := m.StartLogin(context.Background(), "owner@example.com")
	require.NoError(t, err)
	m.CancelLogin()

	// The process is killed; no completion event, no error shown.
	select {
	case event := <-events:
		t.Fatalf("unexpected event %q", event)
	case <-time.After(300 * time.Millisecond):
	}
	status := m.Status(context.Background(), true)
	assert.Equal(t, StateNotConnected, status.State)
	assert.Empty(t, status.LastError)
}

func TestMissingCLI(t *testing.T) {
	m, err := New(t.TempDir(), nil)
	require.NoError(t, err)
	m.bin = ""
	assert.Equal(t, StateNotInstalled, m.Status(context.Background(), true).State)
	_, err = m.StartLogin(context.Background(), "x")
	assert.ErrorIs(t, err, ErrNotInstalled)
}

func TestManagerIsSafeForConcurrentStatus(t *testing.T) {
	m, _, _ := newFake(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = m.Status(context.Background(), i%2 == 0)
		}()
	}
	wg.Wait()
}

func TestModelsListsVisibleModelsBestFirst(t *testing.T) {
	m, _, _ := newFake(t)
	list, err := m.Models(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 2)
	assert.Equal(t, "gpt-a", list[0].Slug)
	assert.Equal(t, Model{Slug: "gpt-b", Name: "B", DefaultEffort: "low", Efforts: []string{"low", "high"}}, list[1])
}

func TestHomeIsMadeAbsolute(t *testing.T) {
	t.Chdir(t.TempDir())
	m, err := New("data/codex", nil)
	require.NoError(t, err)
	assert.True(t, filepath.IsAbs(m.home), m.home)
	assert.Contains(t, m.environment(), "CODEX_HOME="+m.home)
}
