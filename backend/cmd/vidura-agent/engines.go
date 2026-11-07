package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
)

// recipe is how one engine is installed. The server only names an engine;
// the commands below are fixed here, so the server can't run anything else
// on this Mac.
type recipe struct {
	name    string
	pkg     string // uv tool package
	binary  string // command the package provides
	model   string // Hugging Face repository with the weights
	missing string // shown when there is no installer
}

var recipes = map[string]recipe{
	"parakeet": {name: "Parakeet TDT 0.6B v2", pkg: "parakeet-mlx", binary: "parakeet-mlx", model: "mlx-community/parakeet-tdt-0.6b-v2"},
	"whisper":  {name: "Whisper large-v3-turbo", pkg: "mlx-whisper", binary: "mlx_whisper", model: "mlx-community/whisper-large-v3-turbo"},
	"phonon":   {name: "Phonon-2", missing: "No installer for the Core ML runner yet"},
	// Spoken questions: full large-v3 understands Sinhala far better than turbo.
	agentproto.SpeechEngine: {name: "Whisper large-v3 (voice questions)", pkg: "mlx-whisper", binary: "mlx_whisper",
		model: "mlx-community/whisper-large-v3-mlx"},
}

var engineOrder = []string{"parakeet", "phonon", "whisper", agentproto.SpeechEngine}

// extendPath lets the agent find tools installed with uv, pipx or Homebrew
// even when launchd starts it with a bare PATH.
func extendPath() {
	home, _ := os.UserHomeDir()
	path := os.Getenv("PATH")
	for _, dir := range []string{filepath.Join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"} {
		if !strings.Contains(string(os.PathListSeparator)+path+string(os.PathListSeparator), string(os.PathListSeparator)+dir+string(os.PathListSeparator)) {
			path += string(os.PathListSeparator) + dir
		}
	}
	_ = os.Setenv("PATH", path)
}

func has(name string) bool { _, err := exec.LookPath(name); return err == nil }

// modelCached reports whether the Hugging Face cache holds the weights.
func modelCached(repo string) bool {
	hub := os.Getenv("HF_HUB_CACHE")
	if hub == "" {
		base := os.Getenv("HF_HOME")
		if base == "" {
			home, _ := os.UserHomeDir()
			base = filepath.Join(home, ".cache", "huggingface")
		}
		hub = filepath.Join(base, "hub")
	}
	snapshots := filepath.Join(hub, "models--"+strings.ReplaceAll(repo, "/", "--"), "snapshots")
	entries, err := os.ReadDir(snapshots)
	return err == nil && len(entries) > 0
}

// capabilities reports what this Mac can run.
func capabilities() *agentproto.Capabilities {
	hostname, _ := os.Hostname()
	appleSilicon := runtime.GOOS == "darwin" && runtime.GOARCH == "arm64"
	caps := &agentproto.Capabilities{
		AgentVersion: version, Hostname: hostname, OS: runtime.GOOS, Arch: runtime.GOARCH,
		Tools: map[string]bool{"yt-dlp": has("yt-dlp"), "ffmpeg": has("ffmpeg"), "uv": has("uv")},
	}
	for _, id := range engineOrder {
		r := recipes[id]
		engine := agentproto.Engine{ID: id, Name: r.name}
		installed, cached := r.binary != "" && has(r.binary), r.model != "" && modelCached(r.model)
		switch {
		case !appleSilicon:
			engine.Detail = "needs an Apple-silicon Mac"
		case r.missing != "":
			engine.Detail = r.missing
		case installed && cached:
			engine.Ready, engine.Detail = true, "installed, model downloaded"
		case installed:
			engine.Detail = "model not downloaded"
		default:
			engine.Detail = "not installed"
		}
		caps.Engines = append(caps.Engines, engine)
	}
	return caps
}

// --- outbox ---------------------------------------------------------------

// outbox sends on whichever connection is current, so an install that
// outlives a reconnect still reports through the new connection.
var outbox = &sender{}

type sender struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (s *sender) attach(conn *websocket.Conn) { s.mu.Lock(); s.conn = conn; s.mu.Unlock() }

func (s *sender) detach(conn *websocket.Conn) {
	s.mu.Lock()
	if s.conn == conn {
		s.conn = nil
	}
	s.mu.Unlock()
}

func (s *sender) send(ctx context.Context, msg agentproto.Message) error {
	s.mu.Lock()
	conn := s.conn
	s.mu.Unlock()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return wsjson.Write(ctx, conn, msg)
}

// --- installs -------------------------------------------------------------

var (
	installing   = map[string]bool{}
	installingMu sync.Mutex
)

func report(ctx context.Context, engine, state, detail string) {
	slog.Info("engine install", "engine", engine, "state", state, "detail", detail)
	_ = outbox.send(ctx, agentproto.Message{Type: agentproto.TypeInstallStatus, Engine: engine, State: state, Detail: detail})
}

// installEngine installs an engine's package and downloads its model, then
// re-announces the Mac's capabilities.
func installEngine(ctx context.Context, engine string) {
	r, known := recipes[engine]
	if !known {
		return // only engines in the recipe list; anything else is ignored
	}
	installingMu.Lock()
	if installing[engine] {
		installingMu.Unlock()
		return
	}
	installing[engine] = true
	installingMu.Unlock()
	defer func() {
		installingMu.Lock()
		delete(installing, engine)
		installingMu.Unlock()
		_ = outbox.send(ctx, agentproto.Message{Type: agentproto.TypeHello, Capabilities: capabilities()})
	}()

	if r.missing != "" {
		report(ctx, engine, agentproto.InstallFailed, r.missing)
		return
	}
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		report(ctx, engine, agentproto.InstallFailed, "needs an Apple-silicon Mac")
		return
	}
	if !has("uv") {
		report(ctx, engine, agentproto.InstallFailed, "uv isn't installed on the Mac (brew install uv)")
		return
	}
	if !has(r.binary) {
		report(ctx, engine, agentproto.InstallInstalling, "Installing "+r.pkg)
		if err := runStep(ctx, engine, 15*time.Minute, "uv", "tool", "install", r.pkg); err != nil {
			report(ctx, engine, agentproto.InstallFailed, "Install failed: "+err.Error())
			return
		}
	}
	if !modelCached(r.model) {
		report(ctx, engine, agentproto.InstallInstalling, "Downloading the model "+r.model)
		if err := runStep(ctx, engine, 45*time.Minute, "uvx", "--from", "huggingface_hub", "hf", "download", r.model); err != nil {
			report(ctx, engine, agentproto.InstallFailed, "Model download failed: "+err.Error())
			return
		}
	}
	report(ctx, engine, agentproto.InstallReady, "Installed, model downloaded")
}

// runStep runs one fixed command, forwarding its latest output line as
// progress at most every few seconds.
func runStep(ctx context.Context, engine string, timeout time.Duration, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return err
	}
	var last string
	sent := time.Time{}
	scanner := bufio.NewScanner(stdout)
	scanner.Split(scanLinesOrCR)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		last = line
		if time.Since(sent) > 3*time.Second {
			report(ctx, engine, agentproto.InstallInstalling, truncate(line, 160))
			sent = time.Now()
		}
	}
	_, _ = io.Copy(io.Discard, stdout)
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("%v: %s", err, truncate(last, 160))
	}
	return nil
}

// scanLinesOrCR splits on \n or \r, so progress bars count as lines.
func scanLinesOrCR(data []byte, atEOF bool) (int, []byte, error) {
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func truncate(text string, n int) string {
	if r := []rune(text); len(r) > n {
		return string(r[:n]) + "…"
	}
	return text
}
