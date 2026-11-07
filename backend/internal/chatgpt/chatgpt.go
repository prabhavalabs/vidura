// Package chatgpt connects Vidura to the owner's ChatGPT subscription through
// the Codex CLI: device sign-in, status, a test call, and sign-out.
//
// The CLI keeps its credentials in its own CODEX_HOME inside the data
// directory (never the server user's ~/.codex). Tokens never leave that
// folder: the status only reports the account email and plan, read from the
// ID token's claims.
package chatgpt

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// States reported to the admin portal.
const (
	StateNotInstalled = "not_installed"
	StateNotConnected = "not_connected"
	StateConnecting   = "connecting"
	StateConnected    = "connected"
)

// Status is what the Settings page shows.
type Status struct {
	State   string   `json:"state"`
	CLI     CLI      `json:"cli"`
	Account *Account `json:"account"`
	Login   *Login   `json:"login"`
	// LastError is the outcome of the last failed sign-in, if any.
	LastError string    `json:"lastError,omitempty"`
	CheckedAt time.Time `json:"checkedAt"`
}

// CLI describes the installed Codex CLI.
type CLI struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version"`
}

// Account is the signed-in ChatGPT account, from the ID token's claims.
type Account struct {
	Email string `json:"email"`
	Plan  string `json:"plan"`
}

// Login is a device sign-in waiting for the owner to enter the code.
type Login struct {
	URL       string    `json:"url"`
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
	StartedBy string    `json:"startedBy"`
}

// TestResult is the outcome of a tiny round trip through the subscription.
type TestResult struct {
	Reply      string `json:"reply"`
	DurationMs int64  `json:"durationMs"`
}

// ErrNotInstalled is returned when the codex binary isn't on PATH.
var ErrNotInstalled = errors.New("the Codex CLI isn't installed on the server")

// ErrNotConnected is returned by Test when no account is signed in.
var ErrNotConnected = errors.New("ChatGPT isn't connected")

// Manager runs the Codex CLI. It is safe for concurrent use.
type Manager struct {
	home string
	bin  string

	mu        sync.Mutex
	version   string
	login     *Login
	cancel    context.CancelFunc
	lastError string
	cached    *Status
	// The model catalog, cached for an hour.
	modelList []Model
	modelsAt  time.Time
	// onLogin is told when a device sign-in finishes, for the audit log.
	onLogin func(startedBy string, err error)
	// lanes bound how many model calls run at once, per kind of work, so
	// a question never waits behind a translation or a picture.
	lanes map[Lane]chan struct{}
}

// Lane is a kind of model work with its own concurrency limit.
type Lane string

// Lanes.
const (
	// LaneBackground is processing videos (translation): 2 at once.
	LaneBackground Lane = ""
	// LaneStudy is study notes and pictures someone asked for: 2 at once.
	LaneStudy Lane = "study"
	// LaneChat is the tutor answering a question: 2 at once.
	LaneChat Lane = "chat"
)

// New returns a Manager whose CLI state lives in home (created 0700).
// onLogin may be nil.
func New(home string, onLogin func(startedBy string, err error)) (*Manager, error) {
	// The CLI runs in other working directories (Test uses a temporary
	// one), so CODEX_HOME must not be relative.
	home, err := filepath.Abs(home)
	if err != nil {
		return nil, fmt.Errorf("codex home: %w", err)
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return nil, fmt.Errorf("create codex home: %w", err)
	}
	if err := os.Chmod(home, 0o700); err != nil {
		return nil, err
	}
	m := &Manager{home: home, onLogin: onLogin, lanes: map[Lane]chan struct{}{
		LaneBackground: make(chan struct{}, 2),
		LaneStudy:      make(chan struct{}, 2),
		LaneChat:       make(chan struct{}, 2),
	}}
	if path, err := exec.LookPath("codex"); err == nil {
		m.bin = path
	}
	return m, nil
}

// Status reports the connection, re-checking the CLI at most every 20 s
// unless fresh is set.
func (m *Manager) Status(ctx context.Context, fresh bool) Status {
	m.mu.Lock()
	if !fresh && m.cached != nil && time.Since(m.cached.CheckedAt) < 20*time.Second {
		status := *m.cached
		status.Login, status.LastError = m.login, m.lastError
		if m.login != nil {
			status.State = StateConnecting
		}
		m.mu.Unlock()
		return status
	}
	m.mu.Unlock()

	status := Status{State: StateNotInstalled, CheckedAt: time.Now()}
	if m.bin != "" {
		status.CLI = CLI{Installed: true, Version: m.cliVersion(ctx)}
		status.State = StateNotConnected
		if m.loggedIn(ctx) {
			status.State = StateConnected
			status.Account = m.account()
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.cached = &status
	result := status
	result.Login, result.LastError = m.login, m.lastError
	if m.login != nil {
		result.State = StateConnecting
	}
	return result
}

func (m *Manager) cliVersion(ctx context.Context) string {
	m.mu.Lock()
	version := m.version
	m.mu.Unlock()
	if version != "" {
		return version
	}
	out, _, err := m.run(ctx, 5*time.Second, "", "--version")
	if err != nil {
		return ""
	}
	version = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(out), "codex-cli"))
	m.mu.Lock()
	m.version = version
	m.mu.Unlock()
	return version
}

// loggedIn asks the CLI. `codex login status` exits 0 when signed in and 1
// when not, and prints its message on stderr, so both streams are read and
// the exit code decides.
func (m *Manager) loggedIn(ctx context.Context) bool {
	stdout, stderr, err := m.run(ctx, 10*time.Second, "", "login", "status")
	if err != nil {
		return false
	}
	text := strings.ToLower(stdout + "\n" + stderr)
	return !strings.Contains(text, "not logged in")
}

// account reads the email and plan from the stored ID token. Only those two
// claims are read; nothing else from auth.json is ever returned.
func (m *Manager) account() *Account {
	raw, err := os.ReadFile(filepath.Join(m.home, "auth.json"))
	if err != nil {
		return &Account{}
	}
	var auth struct {
		Tokens struct {
			IDToken string `json:"id_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal(raw, &auth) != nil {
		return &Account{}
	}
	parts := strings.Split(auth.Tokens.IDToken, ".")
	if len(parts) < 2 {
		return &Account{}
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return &Account{}
	}
	var claims struct {
		Email string `json:"email"`
		Auth  struct {
			Plan string `json:"chatgpt_plan_type"`
		} `json:"https://api.openai.com/auth"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return &Account{}
	}
	return &Account{Email: claims.Email, Plan: claims.Auth.Plan}
}

var (
	ansi        = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
	loginURL    = regexp.MustCompile(`https://auth\.openai\.com/[^\s]+`)
	loginCode   = regexp.MustCompile(`\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b`)
	loginExpiry = regexp.MustCompile(`expires in (\d+) minutes?`)
)

// StartLogin begins a device sign-in and returns the link and code to show.
// A sign-in already in progress is returned as is.
func (m *Manager) StartLogin(ctx context.Context, startedBy string) (Login, error) {
	if m.bin == "" {
		return Login{}, ErrNotInstalled
	}
	m.mu.Lock()
	if m.login != nil && time.Now().Before(m.login.ExpiresAt) {
		login := *m.login
		m.mu.Unlock()
		return login, nil
	}
	m.mu.Unlock()

	// The CLI process outlives this request: it waits until the owner
	// enters the code (or the code expires).
	procCtx, cancel := context.WithTimeout(context.Background(), 16*time.Minute)
	cmd := m.command(procCtx, "login", "--device-auth")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return Login{}, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		cancel()
		return Login{}, fmt.Errorf("start codex login: %w", err)
	}

	found := make(chan Login, 1)
	// done closes when the CLI's output reaches EOF; the process must not be
	// waited on before that.
	done := make(chan struct{})
	var output bytes.Buffer
	go func() {
		defer close(done)
		scanner := bufio.NewScanner(stdout)
		login := Login{StartedBy: startedBy}
		minutes := 15
		sent := false
		for scanner.Scan() {
			line := ansi.ReplaceAllString(scanner.Text(), "")
			output.WriteString(line + "\n")
			if match := loginURL.FindString(line); match != "" && login.URL == "" {
				login.URL = match
			}
			if match := loginExpiry.FindStringSubmatch(line); match != nil {
				_, _ = fmt.Sscanf(match[1], "%d", &minutes)
			}
			if match := loginCode.FindString(line); match != "" && login.URL != "" && login.Code == "" {
				login.Code = match
			}
			if !sent && login.URL != "" && login.Code != "" {
				login.ExpiresAt = time.Now().Add(time.Duration(minutes) * time.Minute)
				found <- login
				sent = true
			}
		}
		_, _ = io.Copy(io.Discard, stdout)
	}()

	select {
	case login := <-found:
		m.mu.Lock()
		m.login, m.cancel, m.lastError = &login, cancel, ""
		m.mu.Unlock()
		go m.waitLogin(cmd, done, cancel, startedBy)
		return login, nil
	case <-done:
	case <-time.After(20 * time.Second):
	case <-ctx.Done():
	}
	cancel()
	<-done
	_ = cmd.Wait()
	return Login{}, fmt.Errorf("codex didn't print a sign-in code: %s", strings.TrimSpace(lastLines(output.String(), 3)))
}

func (m *Manager) waitLogin(cmd *exec.Cmd, done <-chan struct{}, cancel context.CancelFunc, startedBy string) {
	<-done
	err := cmd.Wait()
	cancel()
	m.mu.Lock()
	cancelled := m.login == nil
	m.login, m.cancel, m.cached = nil, nil, nil
	if err != nil && !cancelled {
		m.lastError = "The sign-in didn't complete. The code may have expired; try again."
	}
	m.mu.Unlock()
	if m.onLogin != nil && !cancelled {
		m.onLogin(startedBy, err)
	}
}

// CancelLogin stops a device sign-in in progress.
func (m *Manager) CancelLogin() {
	m.mu.Lock()
	cancel := m.cancel
	m.login, m.cancel = nil, nil
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Logout signs the CLI out of ChatGPT.
func (m *Manager) Logout(ctx context.Context) error {
	if m.bin == "" {
		return ErrNotInstalled
	}
	m.CancelLogin()
	_, stderr, err := m.run(ctx, 15*time.Second, "", "logout")
	m.mu.Lock()
	m.cached = nil
	m.mu.Unlock()
	if err != nil {
		return fmt.Errorf("codex logout: %v: %s", err, strings.TrimSpace(stderr))
	}
	return nil
}

// Test sends a one-word prompt through the subscription and times it.
func (m *Manager) Test(ctx context.Context) (TestResult, error) {
	if m.bin == "" {
		return TestResult{}, ErrNotInstalled
	}
	if !m.loggedIn(ctx) {
		return TestResult{}, ErrNotConnected
	}
	workdir, err := os.MkdirTemp("", "vidura-codex-test-")
	if err != nil {
		return TestResult{}, err
	}
	defer os.RemoveAll(workdir)
	replyFile := filepath.Join(workdir, "reply.txt")

	started := time.Now()
	_, stderr, err := m.run(ctx, 2*time.Minute, workdir,
		"exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
		"--sandbox", "read-only",
		"--config", `forced_login_method="chatgpt"`,
		"--config", `web_search="disabled"`,
		"--output-last-message", replyFile,
		"Reply with exactly one word: ready")
	if err != nil {
		return TestResult{}, fmt.Errorf("codex exec failed: %s", strings.TrimSpace(lastLines(stderr, 3)))
	}
	reply, _ := os.ReadFile(replyFile)
	return TestResult{Reply: strings.TrimSpace(string(reply)), DurationMs: time.Since(started).Milliseconds()}, nil
}

// --- process helpers (from Thulawa's runner) ------------------------------

func (m *Manager) command(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, m.bin, args...)
	cmd.Env = m.environment()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

func (m *Manager) run(ctx context.Context, timeout time.Duration, dir string, args ...string) (string, string, error) {
	if m.bin == "" {
		return "", "", ErrNotInstalled
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := m.command(ctx, args...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	return ansi.ReplaceAllString(stdout.String(), ""), ansi.ReplaceAllString(stderr.String(), ""), err
}

// environment passes only what the CLI needs, with CODEX_HOME pointing at
// Vidura's own folder.
func (m *Manager) environment() []string {
	env := []string{"CODEX_HOME=" + m.home, "NO_COLOR=1"}
	for _, key := range []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func lastLines(text string, n int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " ")
}

// Model is one entry of the Codex model catalog that the CLI offers.
type Model struct {
	Slug          string   `json:"slug"`
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	DefaultEffort string   `json:"defaultEffort"`
	Efforts       []string `json:"efforts"`
}

// Models returns the models the CLI lists for ChatGPT accounts (hidden ones
// left out), best first. The catalog is read with `codex debug models` and
// cached for an hour.
func (m *Manager) Models(ctx context.Context) ([]Model, error) {
	if m.bin == "" {
		return nil, ErrNotInstalled
	}
	m.mu.Lock()
	cached, at := m.modelList, m.modelsAt
	m.mu.Unlock()
	if cached != nil && time.Since(at) < time.Hour {
		return cached, nil
	}
	out, stderr, err := m.run(ctx, 20*time.Second, "", "debug", "models")
	if err != nil {
		return nil, fmt.Errorf("codex debug models: %v: %s", err, strings.TrimSpace(lastLines(stderr, 2)))
	}
	parsed, err := parseModels([]byte(out))
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.modelList, m.modelsAt = parsed, time.Now()
	m.mu.Unlock()
	return parsed, nil
}

func parseModels(raw []byte) ([]Model, error) {
	var catalog struct {
		Models []struct {
			Slug          string `json:"slug"`
			DisplayName   string `json:"display_name"`
			Description   string `json:"description"`
			DefaultEffort string `json:"default_reasoning_level"`
			Levels        []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
			Visibility string `json:"visibility"`
			Priority   int    `json:"priority"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		return nil, fmt.Errorf("read model catalog: %w", err)
	}
	sort.SliceStable(catalog.Models, func(a, b int) bool { return catalog.Models[a].Priority < catalog.Models[b].Priority })
	out := []Model{}
	for _, entry := range catalog.Models {
		if entry.Visibility != "list" || entry.Slug == "" {
			continue
		}
		model := Model{Slug: entry.Slug, Name: entry.DisplayName, Description: entry.Description, DefaultEffort: entry.DefaultEffort}
		for _, level := range entry.Levels {
			model.Efforts = append(model.Efforts, level.Effort)
		}
		out = append(out, model)
	}
	return out, nil
}
