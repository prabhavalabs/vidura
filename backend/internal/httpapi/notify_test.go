package httpapi

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/push"
)

func TestClientLanguagePreference(t *testing.T) {
	e := newEnv(t, nil)
	_, cookie := e.clientSignIn("owner-sub", "owner@example.com")

	me := decode(t, e.clientCall(http.MethodGet, "/api/me", "", cookie))["user"].(map[string]any)
	assert.Equal(t, "en", me["locale"], "English until chosen")

	w := e.clientCall(http.MethodPatch, "/api/me/preferences", `{"locale":"si"}`, cookie)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, "si", decode(t, w)["user"].(map[string]any)["locale"])

	assert.Equal(t, http.StatusBadRequest, e.clientCall(http.MethodPatch, "/api/me/preferences", `{"locale":"fr"}`, cookie).Code)
	assert.Equal(t, http.StatusForbidden, e.call(http.MethodPatch, "/api/me/preferences", `{"locale":"si"}`, e.ownerCookie).Code,
		"the admin portal doesn't use it")
}

func TestClientPushRoutes(t *testing.T) {
	e := newEnv(t, nil, func(d *Deps) { d.Push = push.New(d.DB, clientOrigin) })
	_, cookie := e.clientSignIn("owner-sub", "owner@example.com")

	key := e.clientCall(http.MethodGet, "/api/push/key", "", cookie)
	require.Equal(t, http.StatusOK, key.Code, key.Body.String())
	assert.NotEmpty(t, decode(t, key)["publicKey"])

	bad := e.clientCall(http.MethodPost, "/api/push/subscribe",
		`{"endpoint":"https://evil.example/hook","keys":{"p256dh":"x","auth":"y"}}`, cookie)
	assert.Equal(t, http.StatusBadRequest, bad.Code, "only browser push services")

	endpoint := `{"endpoint":"https://fcm.googleapis.com/fcm/send/abc"}`
	ok := e.clientCall(http.MethodPost, "/api/push/subscribe",
		`{"endpoint":"https://fcm.googleapis.com/fcm/send/abc","keys":{"p256dh":"x","auth":"y"}}`, cookie)
	require.Equal(t, http.StatusNoContent, ok.Code, ok.Body.String())
	assert.Equal(t, true, decode(t, e.clientCall(http.MethodPost, "/api/push/status", endpoint, cookie))["subscribed"])
	require.Equal(t, http.StatusNoContent, e.clientCall(http.MethodPost, "/api/push/unsubscribe", endpoint, cookie).Code)
	assert.Equal(t, false, decode(t, e.clientCall(http.MethodPost, "/api/push/status", endpoint, cookie))["subscribed"])

	off := newEnv(t, nil)
	_, offCookie := off.clientSignIn("owner-sub", "owner@example.com")
	assert.Equal(t, http.StatusServiceUnavailable, off.clientCall(http.MethodGet, "/api/push/key", "", offCookie).Code)
}

func TestClientNotificationRoutes(t *testing.T) {
	var notifier *push.Service
	e := newEnv(t, nil, func(d *Deps) {
		notifier = push.New(d.DB, clientOrigin)
		d.Push = notifier
	})
	user, cookie := e.clientSignIn("owner-sub", "owner@example.com")
	_, err := e.store.CreateInvite(t.Context(), e.owner, "family@example.com")
	require.NoError(t, err)
	_, otherCookie := e.clientSignIn("family-sub", "family@example.com")

	empty := decode(t, e.clientCall(http.MethodGet, "/api/notifications", "", cookie))
	assert.Equal(t, float64(0), empty["unread"])
	assert.Empty(t, empty["notifications"])

	ctx := t.Context()
	_, err = notifier.Send(ctx, user.ID, push.Message{Title: "Video", Body: "ready", URL: "/watch/v1", Tag: "video-v1", Kind: "video_ready"})
	require.NoError(t, err)
	_, err = notifier.Send(ctx, user.ID, push.Message{Title: "Chat", Body: "answered", URL: "/ask/t1", Kind: "chat_answer"})
	require.NoError(t, err)

	got := decode(t, e.clientCall(http.MethodGet, "/api/notifications", "", cookie))
	assert.Equal(t, float64(2), got["unread"])
	list := got["notifications"].([]any)
	require.Len(t, list, 2)
	first := list[0].(map[string]any)
	assert.Equal(t, "chat_answer", first["kind"])
	assert.Equal(t, "/ask/t1", first["url"])

	// The heartbeat reports the newest notification and the count.
	beat := e.clientCall(http.MethodPost, "/api/notifications/presence",
		`{"visible":true,"endpoint":"https://fcm.googleapis.com/fcm/send/abc"}`, cookie)
	require.Equal(t, http.StatusOK, beat.Code, beat.Body.String())
	assert.Equal(t, first["id"], decode(t, beat)["latest"])

	// Someone else sees none of it and can't mark it read.
	assert.Empty(t, decode(t, e.clientCall(http.MethodGet, "/api/notifications", "", otherCookie))["notifications"])
	e.clientCall(http.MethodPost, "/api/notifications/read", `{"ids":["`+first["id"].(string)+`"]}`, otherCookie)

	read := e.clientCall(http.MethodPost, "/api/notifications/read", `{"ids":["`+first["id"].(string)+`"]}`, cookie)
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	assert.Equal(t, float64(1), decode(t, read)["unread"])
	assert.Equal(t, float64(0), decode(t, e.clientCall(http.MethodPost, "/api/notifications/read", `{"all":true}`, cookie))["unread"])

	assert.Equal(t, http.StatusBadRequest,
		e.clientCall(http.MethodPost, "/api/notifications/read", `{"bogus":1}`, cookie).Code)
	assert.Equal(t, http.StatusUnauthorized, e.clientCall(http.MethodGet, "/api/notifications", "", nil).Code)

	// The test notification isn't kept in the list.
	require.Equal(t, http.StatusOK, e.clientCall(http.MethodPost, "/api/push/test", "", cookie).Code)
	assert.Len(t, decode(t, e.clientCall(http.MethodGet, "/api/notifications", "", cookie))["notifications"], 2)
}
