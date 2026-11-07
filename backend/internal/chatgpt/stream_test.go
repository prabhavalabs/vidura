package chatgpt

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeAppServer plays the server side of `codex app-server` over pipes: it
// answers initialize, thread/start and turn/start, then sends the turn's
// notifications. It records the requests it got.
type fakeAppServer struct {
	requests []map[string]any
	// notifications are sent after turn/start's response.
	notifications []string
	// refuse is sent instead of the thread/start result.
	refuse string
	// hangUp closes the connection after the notifications.
	hangUp bool
}

func (f *fakeAppServer) serve(t *testing.T, in io.Reader, out io.WriteCloser) {
	// Everything is written by its own goroutine, like the real server,
	// which keeps reading while it writes (io.Pipe has no buffer).
	send := make(chan string, 256)
	written := make(chan struct{})
	go func() {
		defer close(written)
		for line := range send {
			if line == "" {
				_ = out.Close()
				continue
			}
			_, _ = io.WriteString(out, line+"\n")
		}
		_ = out.Close()
	}()
	defer func() {
		close(send)
		<-written
	}()
	lines := bufio.NewScanner(in)
	for lines.Scan() {
		var req map[string]any
		require.NoError(t, json.Unmarshal(lines.Bytes(), &req))
		f.requests = append(f.requests, req)
		id := req["id"]
		switch req["method"] {
		case "initialize":
			send <- fmt.Sprintf(`{"id":%v,"result":{"userAgent":"fake"}}`, id)
			send <- `{"method":"remoteControl/status/changed","params":{"status":"disabled"}}`
		case "thread/start":
			if f.refuse != "" {
				send <- fmt.Sprintf(`{"id":%v,"error":{"code":-32000,"message":%q}}`, id, f.refuse)
				send <- "" // hang up
				continue
			}
			send <- fmt.Sprintf(`{"id":%v,"result":{"thread":{"id":"thread-1"}}}`, id)
		case "turn/start":
			send <- fmt.Sprintf(`{"id":%v,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}`, id)
			for _, n := range f.notifications {
				send <- n
			}
			if f.hangUp {
				send <- ""
			}
		}
	}
}

func run(t *testing.T, f *fakeAppServer) (Result, []Delta, error) {
	t.Helper()
	toServer, fromUs := io.Pipe()
	fromServer, toUs := io.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.serve(t, toServer, toUs)
	}()
	var deltas []Delta
	result, err := converse(fromUs, fromServer, turn{Model: "gpt-x", Effort: "low", System: "Be kind.", Input: "Why?", Cwd: "/tmp/x"},
		func(d Delta) { deltas = append(deltas, d) })
	_ = fromUs.Close()
	_ = fromServer.Close()
	<-done
	return result, deltas, err
}

func delta(item, text string) string {
	return fmt.Sprintf(`{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":%q,"delta":%q}}`, item, text)
}

func TestStreamPassesOnEveryDeltaAndTheFinalText(t *testing.T) {
	f := &fakeAppServer{notifications: []string{
		`{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`,
		`{"method":"item/started","params":{"item":{"type":"userMessage","id":"u1"}}}`,
		`{"method":"item/started","params":{"item":{"type":"agentMessage","id":"m1","text":"","phase":"final_answer"}}}`,
		delta("m1", "සිනැප්ස"),
		delta("m1", "ය [0:03]"),
		delta("m1", " signals."),
		`{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m1","text":"සිනැප්සය [0:03] signals.","phase":"final_answer"}}}`,
		`{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"inputTokens":120,"outputTokens":9,"reasoningOutputTokens":2}}}}`,
		`{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed","items":[]}}}`,
	}}
	result, deltas, err := run(t, f)
	require.NoError(t, err)
	assert.Equal(t, []Delta{{Text: "සිනැප්ස"}, {Text: "ය [0:03]"}, {Text: " signals."}}, deltas)
	assert.Equal(t, "සිනැප්සය [0:03] signals.", result.Text)
	assert.Equal(t, 120, result.InputTokens)
	assert.Equal(t, 9, result.OutputTokens)
	assert.Equal(t, 2, result.ReasoningTokens)

	require.Len(t, f.requests, 4)
	assert.Equal(t, "initialize", f.requests[0]["method"])
	assert.Equal(t, "initialized", f.requests[1]["method"])
	assert.Nil(t, f.requests[1]["id"], "initialized is a notification")
	start := f.requests[2]["params"].(map[string]any)
	assert.Equal(t, "gpt-x", start["model"])
	assert.Equal(t, "never", start["approvalPolicy"])
	assert.Equal(t, "read-only", start["sandbox"])
	assert.Equal(t, true, start["ephemeral"])
	assert.Equal(t, "Be kind.", start["baseInstructions"])
	turnParams := f.requests[3]["params"].(map[string]any)
	assert.Equal(t, "thread-1", turnParams["threadId"])
	assert.Equal(t, "low", turnParams["effort"])
	assert.Equal(t, "Why?", turnParams["input"].([]any)[0].(map[string]any)["text"])
}

func TestStreamSkipsCommentaryAndRestartsOnANewMessage(t *testing.T) {
	f := &fakeAppServer{notifications: []string{
		`{"method":"item/started","params":{"item":{"type":"agentMessage","id":"c1","phase":"commentary"}}}`,
		delta("c1", "Let me think"),
		`{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"c1","text":"Let me think","phase":"commentary"}}}`,
		// An approval request: refused, never waited on.
		`{"id":"srv-1","method":"item/commandExecution/requestApproval","params":{}}`,
		delta("m1", "First try"),
		`{"method":"item/started","params":{"item":{"type":"agentMessage","id":"m2","phase":null}}}`,
		delta("m2", "Second"),
		`{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m2","text":"Second","phase":null}}}`,
		`{"method":"turn/completed","params":{"turn":{"status":"completed"}}}`,
	}}
	result, deltas, err := run(t, f)
	require.NoError(t, err)
	assert.Equal(t, []Delta{{Text: "First try"}, {Restart: true}, {Text: "Second"}}, deltas)
	assert.Equal(t, "Second", result.Text)
	refused := f.requests[len(f.requests)-1]
	assert.Equal(t, "srv-1", refused["id"])
	assert.NotNil(t, refused["error"], "the approval was refused")
}

func TestStreamFailuresAreClassified(t *testing.T) {
	quota := &fakeAppServer{notifications: []string{
		delta("m1", "Half an ans"),
		`{"method":"error","params":{"error":{"message":"stream error, retrying","codexErrorInfo":"serverOverloaded"},"willRetry":true}}`,
		`{"method":"error","params":{"error":{"message":"You've hit your usage limit.","codexErrorInfo":"usageLimitExceeded"},"willRetry":false}}`,
		`{"method":"turn/completed","params":{"turn":{"status":"failed","error":{"message":"You've hit your usage limit.","codexErrorInfo":"usageLimitExceeded"}}}}`,
	}}
	_, deltas, err := run(t, quota)
	assert.ErrorIs(t, err, ErrQuota)
	assert.Len(t, deltas, 1, "what came before the failure was still shown")

	auth := &fakeAppServer{notifications: []string{
		`{"method":"turn/completed","params":{"turn":{"status":"failed","error":{"message":"401","codexErrorInfo":"unauthorized"}}}}`,
	}}
	_, _, err = run(t, auth)
	assert.ErrorIs(t, err, ErrAuth)

	_, _, err = run(t, &fakeAppServer{refuse: "model not found"})
	assert.ErrorContains(t, err, "model not found")

	gone := &fakeAppServer{notifications: []string{delta("m1", "cut off")}, hangUp: true}
	_, _, err = run(t, gone)
	assert.ErrorIs(t, err, errServerGone, "the server went away before the turn completed")

	empty := &fakeAppServer{notifications: []string{`{"method":"turn/completed","params":{"turn":{"status":"completed"}}}`}}
	_, _, err = run(t, empty)
	assert.ErrorContains(t, err, "empty answer")
}

// fakeAppServerScript is a codex whose app-server answers one turn with two
// deltas, or never answers when the question asks it to hang.
const fakeAppServerScript = `#!/bin/sh
[ "$1" = "app-server" ] || exit 2
read init;  echo '{"id":1,"result":{}}'
read ready
read start; echo '{"id":2,"result":{"thread":{"id":"t"}}}'
read turn;  echo '{"id":3,"result":{"turn":{"id":"u"}}}'
case "$turn" in
  *hang*) read never ;;
esac
echo '{"method":"item/agentMessage/delta","params":{"itemId":"m","delta":"Hello"}}'
echo '{"method":"item/agentMessage/delta","params":{"itemId":"m","delta":", world"}}'
echo '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m","text":"Hello, world"}}}'
echo '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'
read never
`

func scriptedManager(t *testing.T) *Manager {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "codex")
	require.NoError(t, os.WriteFile(bin, []byte(fakeAppServerScript), 0o700))
	m, err := New(filepath.Join(dir, "home"), nil)
	require.NoError(t, err)
	m.bin = bin
	return m
}

func TestStreamRunsTheAppServerAndStopsIt(t *testing.T) {
	m := scriptedManager(t)
	var text strings.Builder
	result, err := m.Stream(context.Background(), Request{Model: "gpt-x", Lane: LaneChat, Input: "hi"},
		func(d Delta) { text.WriteString(d.Text) })
	require.NoError(t, err, "the server is stopped once the turn completes, though it would wait forever")
	assert.Equal(t, "Hello, world", text.String())
	assert.Equal(t, "Hello, world", result.Text)
}

func TestStreamIsCancelledWithItsContext(t *testing.T) {
	m := scriptedManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(200*time.Millisecond, cancel)
	started := time.Now()
	_, err := m.Stream(ctx, Request{Model: "gpt-x", Lane: LaneChat, Input: "please hang"}, nil)
	assert.ErrorIs(t, err, context.Canceled)
	assert.Less(t, time.Since(started), 5*time.Second)

	_, err = m.Stream(context.Background(), Request{Model: "gpt-x", Lane: LaneChat, Input: "please hang", Timeout: 200 * time.Millisecond}, nil)
	assert.ErrorContains(t, err, "didn't answer within")

	// Both lane places were given back.
	_, err = m.Stream(context.Background(), Request{Model: "gpt-x", Lane: LaneChat, Input: "hi"}, nil)
	require.NoError(t, err)
}
