package httpapi

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClientLibraryAddListWatchDelete(t *testing.T) {
	woken := 0
	e := newEnv(t, nil, func(d *Deps) { d.JobQueued = func() { woken++ } })
	_, cookie := e.clientSignIn("owner-sub", "owner@example.com")

	empty := e.clientCall(http.MethodGet, "/api/videos", "", cookie)
	require.Equal(t, http.StatusOK, empty.Code, empty.Body.String())
	assert.Empty(t, decode(t, empty)["videos"])

	bad := e.clientCall(http.MethodPost, "/api/videos", `{"url":"https://vimeo.com/123"}`, cookie)
	assert.Equal(t, http.StatusBadRequest, bad.Code)
	assert.Contains(t, bad.Body.String(), "bad_url")

	added := e.clientCall(http.MethodPost, "/api/videos", `{"url":"https://youtu.be/dQw4w9WgXcQ?t=42"}`, cookie)
	require.Equal(t, http.StatusCreated, added.Code, added.Body.String())
	body := decode(t, added)
	video := body["video"].(map[string]any)
	assert.Equal(t, "dQw4w9WgXcQ", video["youtubeId"])
	assert.Equal(t, "queued", video["status"])
	assert.Equal(t, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", video["thumbnailUrl"])
	assert.Equal(t, "process_video", body["job"].(map[string]any)["kind"])
	assert.Equal(t, true, body["created"])
	assert.Equal(t, 1, woken, "the worker is woken")
	id := video["id"].(string)

	again := e.clientCall(http.MethodPost, "/api/videos", `{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}`, cookie)
	require.Equal(t, http.StatusOK, again.Code, "the same video isn't added twice")
	againBody := decode(t, again)
	assert.Equal(t, id, againBody["video"].(map[string]any)["id"])
	assert.Equal(t, false, againBody["created"])
	assert.NotNil(t, againBody["job"], "its open run is returned")

	list := decode(t, e.clientCall(http.MethodGet, "/api/videos", "", cookie))["videos"].([]any)
	require.Len(t, list, 1)

	detail := e.clientCall(http.MethodGet, "/api/videos/"+id, "", cookie)
	require.Equal(t, http.StatusOK, detail.Code)
	detailBody := decode(t, detail)
	assert.Empty(t, detailBody["segments"])
	lastJob, _ := detailBody["video"].(map[string]any)["lastJob"].(map[string]any)
	require.NotNil(t, lastJob, "the watch page shows the current run's progress")
	assert.Equal(t, "queued", lastJob["status"])

	open := e.clientCall(http.MethodPost, "/api/videos/"+id+"/jobs", `{"kind":"retranslate"}`, cookie)
	assert.Equal(t, http.StatusConflict, open.Code, "one run at a time")

	assert.Equal(t, http.StatusNoContent, e.clientCall(http.MethodDelete, "/api/videos/"+id, "", cookie).Code)
	assert.Equal(t, http.StatusNotFound, e.clientCall(http.MethodGet, "/api/videos/"+id, "", cookie).Code)
}

func TestClientLibraryIsPrivateToEachUser(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	_, err := e.store.CreateInvite(ctx, e.owner, "family@example.com")
	require.NoError(t, err)
	_, ownerCookie := e.clientSignIn("owner-sub", "owner@example.com")
	_, familyCookie := e.clientSignIn("family-sub", "family@example.com")

	added := e.clientCall(http.MethodPost, "/api/videos", `{"url":"dQw4w9WgXcQ"}`, ownerCookie)
	require.Equal(t, http.StatusCreated, added.Code, added.Body.String())
	id := decode(t, added)["video"].(map[string]any)["id"].(string)

	assert.Empty(t, decode(t, e.clientCall(http.MethodGet, "/api/videos", "", familyCookie))["videos"])
	for name, w := range map[string]int{
		"read":   e.clientCall(http.MethodGet, "/api/videos/"+id, "", familyCookie).Code,
		"delete": e.clientCall(http.MethodDelete, "/api/videos/"+id, "", familyCookie).Code,
		"rerun":  e.clientCall(http.MethodPost, "/api/videos/"+id+"/jobs", `{"kind":"retranslate"}`, familyCookie).Code,
	} {
		assert.Equal(t, http.StatusNotFound, w, "someone else's video: %s", name)
	}

	// The same link in another library is a separate video.
	theirs := e.clientCall(http.MethodPost, "/api/videos", `{"url":"dQw4w9WgXcQ"}`, familyCookie)
	require.Equal(t, http.StatusCreated, theirs.Code)
	assert.NotEqual(t, id, decode(t, theirs)["video"].(map[string]any)["id"])
}

func TestClientAPIOnlyAnswersTheClientPortal(t *testing.T) {
	e := newEnv(t, nil)
	_, clientCookie := e.clientSignIn("owner-sub", "owner@example.com")

	assert.Equal(t, http.StatusUnauthorized, e.clientCall(http.MethodGet, "/api/videos", "", nil).Code)
	// The admin portal, even with the owner's admin session, can't use it.
	assert.Equal(t, http.StatusForbidden, e.call(http.MethodGet, "/api/videos", "", e.ownerCookie).Code)
	// A client session sent from elsewhere isn't read at all.
	assert.Equal(t, http.StatusUnauthorized, e.request(apiOrigin, http.MethodGet, "/api/videos", "", adminOrigin, clientCookie).Code)
	assert.Equal(t, http.StatusUnauthorized, e.request(apiOrigin, http.MethodPost, "/api/videos", `{"url":"dQw4w9WgXcQ"}`, "https://evil.example", clientCookie).Code)
	// And the client session can't reach the admin API.
	assert.Equal(t, http.StatusForbidden, e.clientCall(http.MethodGet, "/api/admin/videos", "", clientCookie).Code)
}

func TestClientLibrarySearchFiltersAndPages(t *testing.T) {
	e := newEnv(t, nil)
	_, cookie := e.clientSignIn("owner-sub", "owner@example.com")
	for _, id := range []string{"aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"} {
		w := e.clientCall(http.MethodPost, "/api/videos", `{"url":"`+id+`"}`, cookie)
		require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	}
	_, err := e.server.deps.DB.Exec(`UPDATE jobs SET status = 'succeeded' WHERE video_id IN
		(SELECT id FROM videos WHERE youtube_video_id = 'aaaaaaaaaaa')`)
	require.NoError(t, err)
	_, err = e.server.deps.DB.Exec(`UPDATE videos SET status = 'ready', title = 'Neurons 100% explained'
		WHERE youtube_video_id = 'aaaaaaaaaaa'`)
	require.NoError(t, err)

	page := func(query string) map[string]any {
		w := e.clientCall(http.MethodGet, "/api/videos?"+query, "", cookie)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		return decode(t, w)
	}

	first := page("size=2&page=1")
	assert.Len(t, first["videos"], 2)
	assert.Equal(t, float64(3), first["total"])
	assert.Equal(t, map[string]any{"all": 3.0, "ready": 1.0, "processing": 2.0, "failed": 0.0}, first["counts"])
	second := page("size=2&page=2")
	assert.Len(t, second["videos"], 1, "the last page holds the rest")

	ready := page("filter=ready")
	require.Len(t, ready["videos"], 1)
	assert.Equal(t, "Neurons 100% explained", ready["videos"].([]any)[0].(map[string]any)["title"])
	assert.Len(t, page("filter=processing")["videos"], 2)

	assert.Len(t, page("q=NEURONS")["videos"], 1, "search ignores case")
	assert.Len(t, page("q=100%25")["videos"], 1, "a % in the search is literal")
	assert.Empty(t, page("q=5%25")["videos"])
	searched := page("q=neurons")
	assert.Equal(t, 1.0, searched["counts"].(map[string]any)["all"], "counts follow the search")

	assert.Equal(t, http.StatusBadRequest, e.clientCall(http.MethodGet, "/api/videos?filter=nope", "", cookie).Code)
}
