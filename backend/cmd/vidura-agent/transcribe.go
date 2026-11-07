package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
)

// A transcription takes only a YouTube id and an engine id from the server.
// Everything it runs is fixed below: yt-dlp downloads the audio into a fresh
// private folder, the engine's own CLI transcribes it, and the folder is
// deleted afterwards. Nothing from the server reaches a shell.

const maxTranscription = 3 * time.Hour

var (
	jobsMu sync.Mutex
	jobs   = map[string]context.CancelFunc{}
)

// transcribe handles a transcribe.request. One runs at a time; a second is
// refused so the Mac isn't overloaded.
func transcribe(ctx context.Context, msg agentproto.Message) {
	fail := func(detail string) {
		slog.Warn("transcription failed", "request", msg.RequestID, "detail", detail)
		_ = outbox.send(ctx, agentproto.Message{Type: agentproto.TypeTranscribeFailed, RequestID: msg.RequestID, Detail: detail})
	}
	if msg.RequestID == "" || len(msg.RequestID) > 64 {
		return
	}
	if !agentproto.YouTubeID.MatchString(msg.YouTubeID) {
		fail("invalid YouTube id")
		return
	}
	r, ok := recipes[msg.Engine]
	if !ok || r.binary == "" || !has(r.binary) || !modelCached(r.model) {
		fail(fmt.Sprintf("the %s engine isn't ready on this Mac", msg.Engine))
		return
	}

	jobsMu.Lock()
	if len(jobs) > 0 {
		jobsMu.Unlock()
		fail("this Mac is already transcribing another video")
		return
	}
	ctx, cancel := context.WithTimeout(ctx, maxTranscription)
	jobs[msg.RequestID] = cancel
	jobsMu.Unlock()
	defer func() {
		cancel()
		jobsMu.Lock()
		delete(jobs, msg.RequestID)
		jobsMu.Unlock()
	}()

	slog.Info("transcription started", "request", msg.RequestID, "youtube", msg.YouTubeID, "engine", msg.Engine)
	started := time.Now()
	segments, err := runTranscription(ctx, msg.RequestID, msg.YouTubeID, msg.Engine, r)
	if err != nil {
		if ctx.Err() != nil {
			slog.Info("transcription stopped", "request", msg.RequestID)
			return
		}
		fail(err.Error())
		return
	}
	slog.Info("transcription finished", "request", msg.RequestID, "segments", len(segments),
		"took", time.Since(started).Round(time.Second).String())
	if err := outbox.send(ctx, agentproto.Message{Type: agentproto.TypeTranscribeResult, RequestID: msg.RequestID,
		Engine: msg.Engine, Segments: segments}); err != nil {
		slog.Warn("couldn't deliver transcript", "request", msg.RequestID, "err", err)
	}
}

// cancelTranscription stops a running transcription.
func cancelTranscription(id string) {
	jobsMu.Lock()
	if cancel, ok := jobs[id]; ok {
		cancel()
	}
	jobsMu.Unlock()
}

func runTranscription(ctx context.Context, id, youtubeID, engine string, r recipe) ([]agentproto.Segment, error) {
	dir, err := os.MkdirTemp("", "vidura-asr-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	progress := throttle(ctx, id)

	// 1. Audio only, best quality, no playlist, no user config.
	progress(1, "Downloading the audio")
	err = stream(ctx, func(line string) {
		if m := percentPattern.FindStringSubmatch(line); m != nil && strings.Contains(line, "[download]") {
			if p, err := strconv.ParseFloat(m[1], 64); err == nil {
				progress(int(p*0.25), fmt.Sprintf("Downloading the audio (%.0f%%)", p))
			}
		}
	}, "yt-dlp", "--ignore-config", "--no-playlist", "--no-warnings", "--newline",
		"-f", "bestaudio[ext=m4a]/bestaudio", "-o", filepath.Join(dir, "audio.%(ext)s"),
		"--", "https://www.youtube.com/watch?v="+youtubeID)
	if err != nil {
		return nil, fmt.Errorf("audio download failed: %w", err)
	}
	audio, err := findAudio(dir)
	if err != nil {
		return nil, err
	}

	// 2. The engine's CLI writes JSON next to the audio.
	out := filepath.Join(dir, "out")
	if err := os.Mkdir(out, 0o700); err != nil {
		return nil, err
	}
	progress(25, "Transcribing with "+r.name)
	started := time.Now()
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				progress(-1, fmt.Sprintf("Transcribing with %s (%s)", r.name, time.Since(started).Round(time.Second)))
			}
		}
	}()
	var args []string
	switch engine {
	case "parakeet":
		args = []string{audio, "--model", r.model, "--output-format", "json", "--output-dir", out}
	case "whisper":
		args = []string{audio, "--model", r.model, "--output-format", "json", "--output-dir", out, "--language", "en"}
	default:
		close(stop)
		return nil, fmt.Errorf("no runner for %s", engine)
	}
	err = stream(ctx, func(line string) {
		if m := percentPattern.FindStringSubmatch(line); m != nil {
			if p, err := strconv.ParseFloat(m[1], 64); err == nil {
				progress(25+int(p*0.7), fmt.Sprintf("Transcribing with %s (%.0f%%)", r.name, p))
			}
		}
	}, r.binary, args...)
	close(stop)
	if err != nil {
		return nil, fmt.Errorf("%s failed: %w", r.name, err)
	}
	progress(96, "Reading the transcript")
	return readTranscript(out)
}

var percentPattern = regexp.MustCompile(`(\d{1,3}(?:\.\d+)?)%`)

// throttle returns a progress reporter that sends at most every 2 s. A
// negative percent keeps the last one and only updates the note.
func throttle(ctx context.Context, id string) func(int, string) {
	var mu sync.Mutex
	last := time.Time{}
	percent := 0
	return func(p int, note string) {
		mu.Lock()
		defer mu.Unlock()
		if p >= 0 {
			percent = max(percent, min(100, p))
		}
		if time.Since(last) < 2*time.Second {
			return
		}
		last = time.Now()
		_ = outbox.send(ctx, agentproto.Message{Type: agentproto.TypeTranscribeProgress, RequestID: id,
			Percent: percent, Detail: truncate(note, 160)})
	}
}

// stream runs a fixed command and passes each output line to onLine.
func stream(ctx context.Context, onLine func(string), name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = 5 * time.Second
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return err
	}
	var last string
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	scanner.Split(scanLinesOrCR)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		last = line
		onLine(line)
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("%v: %s", err, truncate(last, 200))
	}
	return nil
}

func findAudio(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "audio.") && !strings.HasSuffix(e.Name(), ".part") {
			return filepath.Join(dir, e.Name()), nil
		}
	}
	return "", errors.New("yt-dlp didn't produce an audio file")
}

// readTranscript reads the engine's JSON: Parakeet writes "sentences",
// Whisper writes "segments"; both have start, end (seconds) and text.
func readTranscript(dir string) ([]agentproto.Segment, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		var doc struct {
			Sentences []timed `json:"sentences"`
			Segments  []timed `json:"segments"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("unreadable transcript: %w", err)
		}
		items := doc.Sentences
		if len(items) == 0 {
			items = doc.Segments
		}
		out := make([]agentproto.Segment, 0, len(items))
		for _, item := range items {
			text := strings.TrimSpace(item.Text)
			start, end := int64(math.Round(item.Start*1000)), int64(math.Round(item.End*1000))
			if text == "" || end <= start {
				continue
			}
			out = append(out, agentproto.Segment{StartMs: start, EndMs: end, Text: text})
		}
		if len(out) == 0 {
			return nil, errors.New("the engine produced an empty transcript")
		}
		if len(out) > agentproto.MaxSegments {
			out = out[:agentproto.MaxSegments]
		}
		return out, nil
	}
	return nil, errors.New("the engine didn't write a transcript")
}

type timed struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}
