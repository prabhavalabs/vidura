package agenthub

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
	"github.com/prabhavalabs/vidura/backend/internal/pipeline"
)

// readyAgent pairs and connects an agent that reports parakeet as ready.
func readyAgent(t *testing.T, f *fixture) *websocket.Conn {
	t.Helper()
	ctx := context.Background()
	code, err := f.hub.CreatePairingCode(ctx, f.owner, "")
	require.NoError(t, err)
	_, paired := f.pair(t, code.Code, nil)
	conn, _, err := f.dial(t, paired.Token)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.CloseNow() })
	var welcome agentproto.Message
	require.NoError(t, wsjson.Read(ctx, conn, &welcome))
	require.NoError(t, wsjson.Write(ctx, conn, agentproto.Message{Type: agentproto.TypeHello,
		Capabilities: &agentproto.Capabilities{Engines: []agentproto.Engine{{ID: "parakeet", Ready: true}}}}))
	eventually(t, func() bool {
		f.hub.mu.Lock()
		defer f.hub.mu.Unlock()
		for _, s := range f.hub.sessions {
			if s.ready["parakeet"] {
				return true
			}
		}
		return false
	})
	return conn
}

func TestTranscribeRoundTrip(t *testing.T) {
	f := setup(t)
	conn := readyAgent(t, f)
	ctx := context.Background()

	type outcome struct {
		segments []pipeline.Segment
		engine   string
		err      error
	}
	done := make(chan outcome, 1)
	notes := make(chan string, 10)
	go func() {
		segments, engine, err := f.hub.Transcribe(ctx, "hGDvvUNU-cw", "parakeet", func(_ int, note string) {
			select {
			case notes <- note:
			default:
			}
		})
		done <- outcome{segments, engine, err}
	}()

	var request agentproto.Message
	require.NoError(t, wsjson.Read(ctx, conn, &request))
	assert.Equal(t, agentproto.TypeTranscribe, request.Type)
	assert.Equal(t, "hGDvvUNU-cw", request.YouTubeID, "the agent only gets the id")
	assert.Equal(t, "parakeet", request.Engine)

	// A frame for some other request is ignored.
	require.NoError(t, wsjson.Write(ctx, conn, agentproto.Message{Type: agentproto.TypeTranscribeResult, RequestID: "other",
		Segments: []agentproto.Segment{{StartMs: 0, EndMs: 1, Text: "no"}}}))
	require.NoError(t, wsjson.Write(ctx, conn, agentproto.Message{Type: agentproto.TypeTranscribeProgress,
		RequestID: request.RequestID, Percent: 40, Detail: "Transcribing"}))
	require.NoError(t, wsjson.Write(ctx, conn, agentproto.Message{Type: agentproto.TypeTranscribeResult, RequestID: request.RequestID,
		Segments: []agentproto.Segment{
			{StartMs: 0, EndMs: 2000, Text: " Hello\x07 there. "},
			{StartMs: 3000, EndMs: 2000, Text: "backwards, dropped"},
			{StartMs: 4000, EndMs: 5000, Text: "General Kenobi."},
		}}))

	select {
	case got := <-done:
		require.NoError(t, got.err)
		require.Len(t, got.segments, 2)
		assert.Equal(t, "Hello there.", got.segments[0].Text)
		assert.Equal(t, 1, got.segments[1].Index)
		assert.Contains(t, got.engine, "parakeet")
	case <-time.After(5 * time.Second):
		t.Fatal("no result")
	}
	assert.Contains(t, []string{<-notes, <-notes}, "Transcribing")
}

func TestTranscribeFailsWhenTheMacDisconnects(t *testing.T) {
	f := setup(t)
	conn := readyAgent(t, f)
	ctx := context.Background()
	done := make(chan error, 1)
	go func() {
		_, _, err := f.hub.Transcribe(ctx, "hGDvvUNU-cw", "parakeet", func(int, string) {})
		done <- err
	}()
	var request agentproto.Message
	require.NoError(t, wsjson.Read(ctx, conn, &request))
	_ = conn.Close(websocket.StatusNormalClosure, "bye")
	select {
	case err := <-done:
		require.Error(t, err)
		assert.Contains(t, err.Error(), "disconnected")
	case <-time.After(5 * time.Second):
		t.Fatal("never failed")
	}
}

func TestTranscribeCancelReachesTheMac(t *testing.T) {
	f := setup(t)
	conn := readyAgent(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _, _, _ = f.hub.Transcribe(ctx, "hGDvvUNU-cw", "parakeet", func(int, string) {}) }()
	var request agentproto.Message
	require.NoError(t, wsjson.Read(context.Background(), conn, &request))
	cancel()
	var stop agentproto.Message
	require.NoError(t, wsjson.Read(context.Background(), conn, &stop))
	assert.Equal(t, agentproto.Message{Type: agentproto.TypeTranscribeCancel, RequestID: request.RequestID}, stop)
}

func TestTranscribeRejectsBadInput(t *testing.T) {
	f := setup(t)
	_, _, err := f.hub.Transcribe(context.Background(), "$(reboot)", "parakeet", func(int, string) {})
	assert.Error(t, err)
	_, _, err = f.hub.Transcribe(context.Background(), "hGDvvUNU-cw", "bash", func(int, string) {})
	assert.Error(t, err)
}
