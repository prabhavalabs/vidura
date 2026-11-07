package agenthub

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
	"github.com/prabhavalabs/vidura/backend/internal/pipeline"
)

// ErrNoTranscriber means no paired Mac with the engine ready came online in
// time.
var ErrNoTranscriber = errors.New("no paired Mac with the engine ready is online")

// waitForMac is how long a transcription waits for a ready Mac to connect.
const waitForMac = 2 * time.Minute

// transcription is one request waiting on an agent.
type transcription struct {
	device   string
	session  *session
	progress func(percent int, note string)
	done     chan transcriptionResult
}

type transcriptionResult struct {
	segments []pipeline.Segment
	// A spoken question's words and language.
	text, language string
	err            error
}

// Transcribe sends one video to a connected Mac and waits for its English
// transcript. The Mac gets only the YouTube id and the engine id; what it
// runs is fixed in the agent. It implements worker.Transcriber.
func (h *Hub) Transcribe(ctx context.Context, youtubeID, engine string, progress func(int, string)) ([]pipeline.Segment, string, error) {
	if !agentproto.YouTubeID.MatchString(youtubeID) {
		return nil, "", fmt.Errorf("invalid YouTube id %q", youtubeID)
	}
	if !agentproto.Engines[engine] {
		return nil, "", fmt.Errorf("unknown engine %q", engine)
	}
	device, s, name, err := h.pickDevice(ctx, engine, progress)
	if err != nil {
		return nil, "", err
	}

	id := uuid.NewString()
	t := &transcription{device: device, session: s, progress: progress, done: make(chan transcriptionResult, 1)}
	h.mu.Lock()
	h.pending[id] = t
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
	}()

	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = wsjson.Write(writeCtx, s.conn, agentproto.Message{
		Type: agentproto.TypeTranscribe, RequestID: id, YouTubeID: youtubeID, Engine: engine,
	})
	cancel()
	if err != nil {
		return nil, "", fmt.Errorf("couldn't reach %s: %w", name, err)
	}
	slog.Info("transcription sent", "device", device, "youtube", youtubeID, "engine", engine, "request", id)
	progress(0, "Sent to "+name)

	select {
	case result := <-t.done:
		return result.segments, engine + " · " + name, result.err
	case <-ctx.Done():
		stopCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		_ = wsjson.Write(stopCtx, s.conn, agentproto.Message{Type: agentproto.TypeTranscribeCancel, RequestID: id})
		stop()
		return nil, "", ctx.Err()
	}
}

// pickDevice returns a connected device with the engine ready, waiting a
// little for one to come online.
func (h *Hub) pickDevice(ctx context.Context, engine string, progress func(int, string)) (string, *session, string, error) {
	deadline := time.Now().Add(waitForMac)
	told := false
	for {
		h.mu.Lock()
		ids := make([]string, 0, len(h.sessions))
		for id, s := range h.sessions {
			if s.ready[engine] {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		var chosen *session
		if len(ids) > 0 {
			chosen = h.sessions[ids[0]]
		}
		h.mu.Unlock()
		if chosen != nil {
			var name string
			_ = h.db.QueryRowContext(ctx, `SELECT name FROM devices WHERE id = ?`, ids[0]).Scan(&name)
			if name == "" {
				name = "the Mac"
			}
			return ids[0], chosen, name, nil
		}
		if time.Now().After(deadline) {
			return "", nil, "", fmt.Errorf("%w (%s)", ErrNoTranscriber, engine)
		}
		if !told {
			progress(0, "Waiting for a Mac with "+engine+" ready")
			told = true
		}
		select {
		case <-ctx.Done():
			return "", nil, "", ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// transcriptionMessage handles a transcription frame from an agent. Frames
// for requests that agent wasn't given are ignored.
func (h *Hub) transcriptionMessage(from *session, msg agentproto.Message) {
	h.mu.Lock()
	t, ok := h.pending[msg.RequestID]
	h.mu.Unlock()
	if !ok || t.session != from {
		return
	}
	switch msg.Type {
	case agentproto.TypeTranscribeProgress:
		t.progress(max(0, min(100, msg.Percent)), clean(msg.Detail, 160))
	case agentproto.TypeTranscribeFailed, agentproto.TypeSpeechFailed:
		t.finish(transcriptionResult{err: errors.New(clean(msg.Detail, 300))})
	case agentproto.TypeSpeechResult:
		text := clean(msg.Text, 4000)
		if text == "" {
			t.finish(transcriptionResult{err: ErrNoSpeech})
			return
		}
		t.finish(transcriptionResult{text: text, language: clean(msg.Language, 8)})
	case agentproto.TypeTranscribeResult:
		segments, err := checkSegments(msg.Segments)
		t.finish(transcriptionResult{segments: segments, err: err})
	}
}

func (t *transcription) finish(result transcriptionResult) {
	select {
	case t.done <- result:
	default:
	}
}

// dropTranscriptions fails every request that was waiting on a session that
// just disconnected.
func (h *Hub) dropTranscriptions(device string, s *session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, t := range h.pending {
		if t.device == device && t.session == s {
			t.finish(transcriptionResult{err: errors.New("the Mac disconnected during transcription")})
		}
	}
}

// checkSegments validates what an agent returned.
func checkSegments(in []agentproto.Segment) ([]pipeline.Segment, error) {
	if len(in) == 0 {
		return nil, errors.New("the Mac returned an empty transcript")
	}
	if len(in) > agentproto.MaxSegments {
		return nil, fmt.Errorf("the Mac returned too many segments (%d)", len(in))
	}
	out := make([]pipeline.Segment, 0, len(in))
	for _, s := range in {
		text := clean(s.Text, 2000)
		if text == "" || s.StartMs < 0 || s.EndMs <= s.StartMs || s.EndMs > 48*3600*1000 {
			continue
		}
		out = append(out, pipeline.Segment{Index: len(out), StartMs: s.StartMs, EndMs: s.EndMs, Text: text})
	}
	if len(out) == 0 {
		return nil, errors.New("the Mac's transcript had no usable segments")
	}
	return out, nil
}

// ErrNoSpeech means the recording had no words in it.
var ErrNoSpeech = errors.New("no words were heard in the recording")

// waitForSpeech is how long a spoken question may take on the Mac.
const waitForSpeech = 2 * time.Minute

// Speech sends a spoken question's recording to a connected Mac and returns
// its words and their language ("si", "en", …). Unlike a video, it doesn't
// wait for a Mac to come online: someone is waiting for the answer.
func (h *Hub) Speech(ctx context.Context, audio []byte, audioType string) (string, string, error) {
	if len(audio) == 0 || len(audio) > agentproto.MaxSpeechBytes {
		return "", "", fmt.Errorf("the recording must be up to %d MB", agentproto.MaxSpeechBytes>>20)
	}
	if _, ok := agentproto.SpeechFormats[audioType]; !ok {
		return "", "", fmt.Errorf("unsupported recording type %q", audioType)
	}
	h.mu.Lock()
	ids := make([]string, 0, len(h.sessions))
	for id, s := range h.sessions {
		if s.ready[agentproto.SpeechEngine] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	var s *session
	if len(ids) > 0 {
		s = h.sessions[ids[0]]
	}
	h.mu.Unlock()
	if s == nil {
		return "", "", fmt.Errorf("%w (%s)", ErrNoTranscriber, agentproto.SpeechEngine)
	}

	id := uuid.NewString()
	t := &transcription{device: ids[0], session: s, progress: func(int, string) {}, done: make(chan transcriptionResult, 1)}
	h.mu.Lock()
	h.pending[id] = t
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
	}()

	writeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	err := wsjson.Write(writeCtx, s.conn, agentproto.Message{
		Type: agentproto.TypeSpeech, RequestID: id, Audio: audio, AudioType: audioType,
	})
	cancel()
	if err != nil {
		return "", "", fmt.Errorf("couldn't reach the Mac: %w", err)
	}
	wait, stop := context.WithTimeout(ctx, waitForSpeech)
	defer stop()
	select {
	case result := <-t.done:
		return result.text, result.language, result.err
	case <-wait.Done():
		return "", "", errors.New("the Mac took too long to understand the recording")
	}
}
