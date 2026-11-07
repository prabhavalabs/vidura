package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/learn"
	"github.com/prabhavalabs/vidura/backend/internal/settings"
)

type scriptedAI struct{ text string }

func (a scriptedAI) Exec(context.Context, chatgpt.Request) (chatgpt.Result, error) {
	return chatgpt.Result{Text: a.text}, nil
}

func TestLearnRoutesAreOwnedAndClientOnly(t *testing.T) {
	e := newEnv(t, nil, func(d *Deps) {
		d.Learn = learn.New(d.DB, scriptedAI{text: "An answer [0:01]."}, settings.NewStore(d.DB),
			filepath.Join(t.TempDir(), "images"))
	})
	ctx := context.Background()
	owner, cookie := e.clientSignIn("owner-sub", "owner@example.com")
	_, err := e.store.CreateInvite(ctx, e.owner, "family@example.com")
	require.NoError(t, err)
	_, familyCookie := e.clientSignIn("family-sub", "family@example.com")

	now := db.FormatTime(time.Now())
	_, err = e.server.deps.DB.Exec(`INSERT INTO videos (id, owner_id, youtube_video_id, youtube_url, title, status, created_at, updated_at)
		VALUES ('v1', ?, 'aaaaaaaaaaa', 'https://youtu.be/aaaaaaaaaaa', 'A video', 'ready', ?, ?)`, owner.ID, now, now)
	require.NoError(t, err)
	_, err = e.server.deps.DB.Exec(`INSERT INTO transcript_segments (id, video_id, segment_index, start_ms, end_ms, source_language, text, created_at)
		VALUES ('s1', 'v1', 0, 1000, 2000, 'en', 'Hello.', ?)`, now)
	require.NoError(t, err)

	empty := e.clientCall(http.MethodGet, "/api/videos/v1/insights/summary?locale=si", "", cookie)
	require.Equal(t, http.StatusOK, empty.Code, empty.Body.String())
	assert.Equal(t, "none", decode(t, empty)["status"])

	asked := e.clientCall(http.MethodPost, "/api/videos/v1/chat", `{"question":"What is this?","locale":"en"}`, cookie)
	require.Equal(t, http.StatusAccepted, asked.Code, asked.Body.String())
	messages := decode(t, asked)["messages"].([]any)
	require.Len(t, messages, 2)
	answer := messages[1].(map[string]any)
	assert.Equal(t, "streaming", answer["status"], "the answer is written in the background")

	// Its stream ends with the finished answer, as Server-Sent Events that
	// proxies don't buffer, readable by the client portal.
	stream := e.clientCall(http.MethodGet, "/api/messages/"+answer["id"].(string)+"/stream", "", cookie)
	require.Equal(t, http.StatusOK, stream.Code, stream.Body.String())
	assert.Equal(t, "text/event-stream; charset=utf-8", stream.Header().Get("Content-Type"))
	assert.Equal(t, "no", stream.Header().Get("X-Accel-Buffering"))
	assert.Equal(t, clientOrigin, stream.Header().Get("Access-Control-Allow-Origin"))
	assert.Equal(t, "true", stream.Header().Get("Access-Control-Allow-Credentials"))
	body := stream.Body.String()
	assert.True(t, strings.HasPrefix(body, "event: snapshot\ndata: "), body)
	assert.Contains(t, body, "event: end\ndata: {\"message\":{")
	assert.Contains(t, body, `"content":"An answer [0:01]."`)
	assert.Contains(t, body, `"status":"done"`)
	assert.Equal(t, http.StatusNotFound, e.clientCall(http.MethodGet, "/api/messages/"+answer["id"].(string)+"/stream", "", familyCookie).Code,
		"someone else's answer")
	assert.Equal(t, http.StatusNotFound, e.clientCall(http.MethodGet, "/api/messages/missing/stream", "", cookie).Code)

	history := decode(t, e.clientCall(http.MethodGet, "/api/videos/v1/chat", "", cookie))
	require.Len(t, history["messages"], 2)
	assert.Equal(t, "An answer [0:01].", history["messages"].([]any)[1].(map[string]any)["content"])

	stopped := e.clientCall(http.MethodPost, "/api/messages/"+answer["id"].(string)+"/stop", "", cookie)
	require.Equal(t, http.StatusOK, stopped.Code, stopped.Body.String())
	assert.Equal(t, "done", decode(t, stopped)["message"].(map[string]any)["status"], "a finished answer stays finished")
	retried := e.clientCall(http.MethodPost, "/api/messages/"+answer["id"].(string)+"/retry", `{"locale":"en"}`, cookie)
	assert.Equal(t, http.StatusConflict, retried.Code, "only failed or stopped answers are retried")

	for name, w := range map[string]int{
		"notes":    e.clientCall(http.MethodGet, "/api/videos/v1/insights/summary", "", familyCookie).Code,
		"chat":     e.clientCall(http.MethodPost, "/api/videos/v1/chat", `{"question":"hi"}`, familyCookie).Code,
		"pictures": e.clientCall(http.MethodGet, "/api/videos/v1/pictures", "", familyCookie).Code,
	} {
		assert.Equal(t, http.StatusNotFound, w, "someone else's video: %s", name)
	}
	assert.Equal(t, http.StatusForbidden, e.call(http.MethodGet, "/api/chats", "", e.ownerCookie).Code, "client portal only")
	assert.Equal(t, http.StatusBadRequest, e.clientCall(http.MethodPost, "/api/videos/v1/chat", `{"question":"  "}`, cookie).Code)

	library := e.clientCall(http.MethodPost, "/api/chats", `{"question":"What have I watched?","locale":"en","attachedVideoId":"v1"}`, cookie)
	require.Equal(t, http.StatusAccepted, library.Code, library.Body.String())
	attached := decode(t, library)["messages"].([]any)[0].(map[string]any)["video"].(map[string]any)
	assert.Equal(t, "A video", attached["title"])
	threads := decode(t, e.clientCall(http.MethodGet, "/api/chats", "", cookie))["threads"].([]any)
	require.Len(t, threads, 1, "only library conversations are listed")
	id := threads[0].(map[string]any)["id"].(string)
	assert.Equal(t, http.StatusNotFound, e.clientCall(http.MethodGet, "/api/chats/"+id, "", familyCookie).Code)
	assert.Equal(t, http.StatusNoContent, e.clientCall(http.MethodDelete, "/api/chats/"+id, "", cookie).Code)
}

func TestPictureAddressesNeedAValidSignature(t *testing.T) {
	e := newEnv(t, nil, func(d *Deps) {
		d.Learn = learn.New(d.DB, nil, settings.NewStore(d.DB), t.TempDir())
	})
	url := e.server.signer().URL("missing")
	path := strings.TrimPrefix(url, apiOrigin)
	assert.Equal(t, http.StatusNotFound, e.request(apiOrigin, http.MethodGet, path, "", "", nil).Code, "signed but no such picture")
	assert.Equal(t, http.StatusNotFound, e.request(apiOrigin, http.MethodGet, "/media/images/missing?e=9999999999&s=bad", "", "", nil).Code)
}

func TestVoiceRouteChecksTheRecording(t *testing.T) {
	e := newEnv(t, nil)
	_, cookie := e.clientSignIn("owner-sub", "owner@example.com")
	send := func(contentType, body string) int {
		r := httptest.NewRequest(http.MethodPost, apiOrigin+"/api/voice", strings.NewReader(body))
		r.Header.Set("Content-Type", contentType)
		r.Header.Set("Origin", clientOrigin)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		e.server.ServeHTTP(w, r)
		return w.Code
	}
	assert.Equal(t, http.StatusUnsupportedMediaType, send("text/plain", "hi"))
	assert.Equal(t, http.StatusBadRequest, send("audio/webm", ""))
	assert.Equal(t, http.StatusServiceUnavailable, send("audio/webm;codecs=opus", "audio"), "no Mac paired")
}
