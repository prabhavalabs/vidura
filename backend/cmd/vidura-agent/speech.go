package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
)

// A spoken question takes only a recording and its type from the server.
// The agent saves it under a fixed name in a fresh private folder, runs its
// own Whisper command on it, and deletes the folder. Nothing from the server
// reaches a shell or names a file.

const maxSpeech = 90 * time.Second

// speechSlot lets one recording be understood at a time, alongside any
// video transcription.
var speechSlot = make(chan struct{}, 1)

func speech(ctx context.Context, msg agentproto.Message) {
	fail := func(detail string) {
		slog.Warn("voice question failed", "request", msg.RequestID, "detail", detail)
		_ = outbox.send(ctx, agentproto.Message{Type: agentproto.TypeSpeechFailed, RequestID: msg.RequestID, Detail: detail})
	}
	if msg.RequestID == "" || len(msg.RequestID) > 64 {
		return
	}
	ext, ok := agentproto.SpeechFormats[msg.AudioType]
	if !ok || len(msg.Audio) == 0 || len(msg.Audio) > agentproto.MaxSpeechBytes {
		fail("unsupported or empty recording")
		return
	}
	r := recipes[agentproto.SpeechEngine]
	if !has(r.binary) || !modelCached(r.model) {
		fail("voice questions aren't set up on this Mac (install Whisper large-v3)")
		return
	}
	select {
	case speechSlot <- struct{}{}:
		defer func() { <-speechSlot }()
	case <-time.After(30 * time.Second):
		fail("this Mac is busy with another voice question")
		return
	case <-ctx.Done():
		return
	}
	ctx, cancel := context.WithTimeout(ctx, maxSpeech)
	defer cancel()

	started := time.Now()
	text, language, err := understand(ctx, r, msg.Audio, ext)
	if err != nil {
		fail(err.Error())
		return
	}
	slog.Info("voice question understood", "request", msg.RequestID, "language", language,
		"took", time.Since(started).Round(100*time.Millisecond).String())
	_ = outbox.send(ctx, agentproto.Message{Type: agentproto.TypeSpeechResult, RequestID: msg.RequestID,
		Text: text, Language: language})
}

// understand transcribes a recording. Whisper detects the language itself;
// people here speak Sinhala or English, so when it guesses anything else
// (short Sinhala clips can be taken for Hindi or Tamil) it runs again as
// Sinhala.
func understand(ctx context.Context, r recipe, audio []byte, ext string) (string, string, error) {
	dir, err := os.MkdirTemp("", "vidura-speech-")
	if err != nil {
		return "", "", err
	}
	defer os.RemoveAll(dir)
	input := filepath.Join(dir, "question."+ext)
	if err := os.WriteFile(input, audio, 0o600); err != nil {
		return "", "", err
	}
	text, language, err := whisper(ctx, r, dir, input, "")
	if err != nil {
		return "", "", err
	}
	if language != "en" && language != "si" {
		text, language, err = whisper(ctx, r, dir, input, "si")
		if err != nil {
			return "", "", err
		}
	}
	return text, language, nil
}

func whisper(ctx context.Context, r recipe, dir, input, language string) (string, string, error) {
	out := filepath.Join(dir, "out-"+language)
	if err := os.MkdirAll(out, 0o700); err != nil {
		return "", "", err
	}
	args := []string{input, "--model", r.model, "--output-format", "json", "--output-dir", out,
		"--task", "transcribe", "--condition-on-previous-text", "False", "--verbose", "False"}
	if language != "" {
		args = append(args, "--language", language)
	}
	if err := stream(ctx, func(string) {}, r.binary, args...); err != nil {
		return "", "", fmt.Errorf("Whisper failed: %w", err)
	}
	raw, err := os.ReadFile(filepath.Join(out, "question.json"))
	if err != nil {
		return "", "", errors.New("Whisper didn't write its result")
	}
	var doc struct {
		Text     string `json:"text"`
		Language string `json:"language"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", fmt.Errorf("unreadable Whisper result: %w", err)
	}
	if language != "" {
		doc.Language = language
	}
	return strings.TrimSpace(doc.Text), doc.Language, nil
}
