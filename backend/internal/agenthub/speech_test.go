package agenthub

import (
	"context"
	"testing"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
)

// speechAgent pairs and connects an agent with the voice engine ready.
func speechAgent(t *testing.T, f *fixture) *websocket.Conn {
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
		Capabilities: &agentproto.Capabilities{Engines: []agentproto.Engine{{ID: agentproto.SpeechEngine, Ready: true}}}}))
	eventually(t, func() bool {
		f.hub.mu.Lock()
		defer f.hub.mu.Unlock()
		for _, s := range f.hub.sessions {
			if s.ready[agentproto.SpeechEngine] {
				return true
			}
		}
		return false
	})
	return conn
}

func TestSpeechRoundTrip(t *testing.T) {
	f := setup(t)
	conn := speechAgent(t, f)
	ctx := context.Background()

	type outcome struct {
		text, language string
		err            error
	}
	done := make(chan outcome, 1)
	go func() {
		text, language, err := f.hub.Speech(ctx, []byte("OggS…audio"), "audio/ogg")
		done <- outcome{text, language, err}
	}()

	var request agentproto.Message
	require.NoError(t, wsjson.Read(ctx, conn, &request))
	assert.Equal(t, agentproto.TypeSpeech, request.Type)
	assert.Equal(t, []byte("OggS…audio"), request.Audio)
	assert.Equal(t, "audio/ogg", request.AudioType)
	assert.Empty(t, request.YouTubeID)

	require.NoError(t, wsjson.Write(ctx, conn, agentproto.Message{Type: agentproto.TypeSpeechResult,
		RequestID: request.RequestID, Text: " නියුරෝන කතා කරන්නේ කොහොමද?\x07 ", Language: "si"}))
	got := <-done
	require.NoError(t, got.err)
	assert.Equal(t, "නියුරෝන කතා කරන්නේ කොහොමද?", got.text, "control characters are cleaned")
	assert.Equal(t, "si", got.language)
}

func TestSpeechNeedsAReadyMacAndAValidRecording(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	_, _, err := f.hub.Speech(ctx, []byte("x"), "audio/webm")
	assert.ErrorIs(t, err, ErrNoTranscriber, "no Mac: fails at once, doesn't wait")

	_, _, err = f.hub.Speech(ctx, []byte("x"), "video/mp4")
	assert.Error(t, err)
	_, _, err = f.hub.Speech(ctx, make([]byte, agentproto.MaxSpeechBytes+1), "audio/webm")
	assert.Error(t, err)

	conn := speechAgent(t, f)
	done := make(chan error, 1)
	go func() {
		_, _, err := f.hub.Speech(ctx, []byte("x"), "audio/webm")
		done <- err
	}()
	var request agentproto.Message
	require.NoError(t, wsjson.Read(ctx, conn, &request))
	require.NoError(t, wsjson.Write(ctx, conn, agentproto.Message{Type: agentproto.TypeSpeechResult,
		RequestID: request.RequestID, Text: "  "}))
	assert.ErrorIs(t, <-done, ErrNoSpeech)
}
