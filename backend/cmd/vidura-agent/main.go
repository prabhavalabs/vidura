// Command vidura-agent runs on the owner's Mac and transcribes videos that
// have no captions. It only ever dials out to the Vidura server.
//
//	vidura-agent pair --server https://api-vidura.example.com --code ABCD-EFGH [--name "Studio Mac"]
//	vidura-agent run       stay connected (reconnects on its own)
//	vidura-agent status    show the pairing (never the token)
//	vidura-agent unpair    forget the pairing on this Mac
//
// The device token is stored in the user's config folder with 0600
// permissions (VIDURA_AGENT_CONFIG overrides the path).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
)

var version = "dev"

type config struct {
	Server   string `json:"server"`
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	Token    string `json:"token"`
}

func main() {
	extendPath()
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "pair":
		err = pair(os.Args[2:])
	case "run":
		err = run()
	case "status":
		err = status()
	case "unpair":
		err = unpair()
	case "version":
		fmt.Println(version)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "vidura-agent:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  vidura-agent pair --server URL --code CODE [--name NAME]
  vidura-agent run | status | unpair | version`)
}

// --- config ---------------------------------------------------------------

func configPath() (string, error) {
	if path := os.Getenv("VIDURA_AGENT_CONFIG"); path != "" {
		return path, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "vidura-agent", "config.json"), nil
}

func loadConfig() (config, error) {
	path, err := configPath()
	if err != nil {
		return config{}, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return config{}, errors.New("this Mac isn't paired; run `vidura-agent pair` first")
	}
	if err != nil {
		return config{}, err
	}
	info, err := os.Stat(path)
	if err == nil && info.Mode().Perm()&0o077 != 0 {
		return config{}, fmt.Errorf("%s is readable by other users; run chmod 600 on it", path)
	}
	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return config{}, fmt.Errorf("read %s: %w", path, err)
	}
	return cfg, nil
}

func saveConfig(cfg config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	encoded, _ := json.MarshalIndent(cfg, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, encoded, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// checkServer refuses to send a token over plain HTTP, except to this
// machine during development.
func checkServer(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("--server must be a full address like https://api-vidura.example.com")
	}
	host := u.Hostname()
	local := host == "localhost" || host == "127.0.0.1" || host == "::1" || strings.HasSuffix(host, ".localhost")
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && local:
	default:
		return nil, fmt.Errorf("the server must use https (plain http is only allowed for localhost)")
	}
	u.Path, u.RawQuery, u.Fragment = "", "", ""
	return u, nil
}

// --- commands -------------------------------------------------------------

func pair(args []string) error {
	flags := flag.NewFlagSet("pair", flag.ContinueOnError)
	server := flags.String("server", "", "Vidura API address")
	code := flags.String("code", "", "pairing code from the admin portal")
	name := flags.String("name", "", "name shown in the admin portal")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *server == "" || *code == "" {
		return errors.New("pair needs --server and --code (both are shown in the admin portal)")
	}
	base, err := checkServer(*server)
	if err != nil {
		return err
	}
	hostname, _ := os.Hostname()
	body, _ := json.Marshal(agentproto.PairRequest{
		Code: *code, Name: *name, Hostname: hostname,
		Platform: runtime.GOOS + "/" + runtime.GOARCH, AgentVersion: version,
	})
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Post(base.String()+agentproto.PairPath, "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("reach %s: %w", base, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var apiErr struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&apiErr)
		return fmt.Errorf("pairing refused (%d): %s", resp.StatusCode, apiErr.Error.Message)
	}
	var paired agentproto.PairResponse
	if err := json.NewDecoder(resp.Body).Decode(&paired); err != nil {
		return err
	}
	if !strings.HasPrefix(paired.Token, agentproto.TokenPrefix) {
		return errors.New("the server returned an unexpected token")
	}
	if err := saveConfig(config{Server: base.String(), DeviceID: paired.DeviceID, Name: paired.Name, Token: paired.Token}); err != nil {
		return err
	}
	path, _ := configPath()
	fmt.Printf("Paired as %q. Saved to %s.\nStart it with: vidura-agent run\n", paired.Name, path)
	return nil
}

func status() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	fmt.Printf("server:  %s\ndevice:  %s\nname:    %s\n", cfg.Server, cfg.DeviceID, cfg.Name)
	caps := capabilities()
	for _, engine := range caps.Engines {
		state := "not ready"
		if engine.Ready {
			state = "ready"
		}
		fmt.Printf("engine:  %-10s %-9s %s\n", engine.ID, state, engine.Detail)
	}
	return nil
}

func unpair() error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Println("Forgot this pairing. Revoke the device in the admin portal too.")
	return nil
}

var errRevoked = errors.New("the server rejected this device (revoked?); pair again")

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	if _, err := checkServer(cfg.Server); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	delay := time.Second
	for {
		started := time.Now()
		err := session(ctx, cfg)
		if ctx.Err() != nil {
			slog.Info("stopped")
			return nil
		}
		if errors.Is(err, errRevoked) {
			return err
		}
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		wait := delay + time.Duration(rand.Int64N(int64(delay/2)+1))
		slog.Warn("disconnected; reconnecting", "error", err, "in", wait.Round(time.Second))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		delay = min(delay*2, time.Minute)
	}
}

// session holds one connection until it drops.
func session(ctx context.Context, cfg config) error {
	wsURL := strings.Replace(cfg.Server, "http", "ws", 1) + agentproto.ConnectPath
	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	conn, resp, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + cfg.Token}},
	})
	cancel()
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return errRevoked
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(agentproto.MaxMessageBytes)

	var welcome agentproto.Message
	if err := wsjson.Read(ctx, conn, &welcome); err != nil || welcome.Type != agentproto.TypeWelcome {
		return fmt.Errorf("no welcome from server: %v", err)
	}
	slog.Info("connected", "server", cfg.Server, "device", welcome.Name)
	outbox.attach(conn)
	defer outbox.detach(conn)
	if err := outbox.send(ctx, agentproto.Message{Type: agentproto.TypeHello, Capabilities: capabilities()}); err != nil {
		return err
	}

	// Server messages arrive on a channel so heartbeats keep going while
	// the read waits.
	messages := make(chan agentproto.Message)
	readErr := make(chan error, 1)
	go func() {
		for {
			var msg agentproto.Message
			if err := wsjson.Read(ctx, conn, &msg); err != nil {
				readErr <- err
				return
			}
			messages <- msg
		}
	}()

	ticker := time.NewTicker(agentproto.HeartbeatSeconds * time.Second)
	defer ticker.Stop()
	for {
		select {
		case err := <-readErr:
			if websocket.CloseStatus(err) == websocket.StatusPolicyViolation {
				return errRevoked
			}
			return fmt.Errorf("connection closed: %w", err)
		case msg := <-messages:
			switch msg.Type {
			case agentproto.TypeInstall:
				go installEngine(ctx, msg.Engine)
			case agentproto.TypeTranscribe:
				// The run outlives this connection: progress and the result
				// go through whichever connection is current.
				go transcribe(ctx, msg)
			case agentproto.TypeTranscribeCancel:
				cancelTranscription(msg.RequestID)
			case agentproto.TypeSpeech:
				go speech(ctx, msg)
			}
		case <-ticker.C:
			if err := outbox.send(ctx, agentproto.Message{Type: agentproto.TypeHeartbeat}); err != nil {
				return err
			}
		}
	}
}
