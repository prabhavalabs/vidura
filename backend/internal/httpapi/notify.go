package httpapi

import (
	"errors"
	"net/http"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/httpx"
	"github.com/prabhavalabs/vidura/backend/internal/push"
)

// preferenceRoutes are the client portal's per-user settings: the language
// it reads in, and this browser's notifications.
func (s *Server) preferenceRoutes(mux *http.ServeMux) {
	c := s.deps.Auth.RequireClient
	mux.HandleFunc("PATCH /api/me/preferences", c(s.updatePreferences))
	mux.HandleFunc("GET /api/push/key", c(s.pushKey))
	mux.HandleFunc("POST /api/push/subscribe", c(s.pushSubscribe))
	mux.HandleFunc("POST /api/push/unsubscribe", c(s.pushUnsubscribe))
	mux.HandleFunc("POST /api/push/status", c(s.pushStatus))
	mux.HandleFunc("POST /api/push/test", c(s.pushTest))
	mux.HandleFunc("GET /api/notifications", c(s.notificationList))
	mux.HandleFunc("POST /api/notifications/read", c(s.notificationsRead))
	mux.HandleFunc("POST /api/notifications/presence", c(s.notificationPresence))
}

func (s *Server) updatePreferences(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Locale string `json:"locale"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	updated, err := s.deps.Accounts.SetLocale(r.Context(), user.ID, body.Locale)
	if errors.Is(err, accounts.ErrInvalidLocale) {
		httpx.WriteError(w, http.StatusBadRequest, "bad_locale", "Vidura speaks English (en) and Sinhala (si).")
		return
	}
	if err != nil {
		serverError(w, "set locale", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"user": auth.PublicUser(updated)})
}

func (s *Server) pushReady(w http.ResponseWriter) bool {
	if s.deps.Push == nil {
		httpx.WriteError(w, http.StatusServiceUnavailable, "push_off", "Notifications aren't available on this server.")
		return false
	}
	return true
}

func (s *Server) pushKey(w http.ResponseWriter, r *http.Request) {
	if !s.pushReady(w) {
		return
	}
	key, err := s.deps.Push.PublicKey(r.Context())
	if err != nil {
		serverError(w, "push key", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"publicKey": key})
}

func (s *Server) pushSubscribe(w http.ResponseWriter, r *http.Request) {
	if !s.pushReady(w) {
		return
	}
	var sub push.Subscription
	if !httpx.DecodeJSON(w, r, &sub) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	err := s.deps.Push.Subscribe(r.Context(), user.ID, sub)
	if errors.Is(err, push.ErrBadSubscription) {
		httpx.WriteError(w, http.StatusBadRequest, "bad_subscription", err.Error())
		return
	}
	if err != nil {
		serverError(w, "push subscribe", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type endpointBody struct {
	Endpoint string `json:"endpoint"`
}

func (s *Server) pushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if !s.pushReady(w) {
		return
	}
	var body endpointBody
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	if err := s.deps.Push.Unsubscribe(r.Context(), user.ID, body.Endpoint); err != nil {
		serverError(w, "push unsubscribe", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) pushStatus(w http.ResponseWriter, r *http.Request) {
	if !s.pushReady(w) {
		return
	}
	var body endpointBody
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	subscribed, err := s.deps.Push.Subscribed(r.Context(), user.ID, body.Endpoint)
	if err != nil {
		serverError(w, "push status", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"subscribed": subscribed})
}

func (s *Server) pushTest(w http.ResponseWriter, r *http.Request) {
	if !s.pushReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	// The test isn't kept in the notification list, and is shown even though
	// the app is open: whoever pressed the button wants to see one.
	m := push.Message{Title: "Vidura", Body: "Notifications are on.", URL: "/settings", Tag: "test",
		Kind: "test", Ephemeral: true, Force: true}
	if user.Locale == "si" {
		m.Body = "දැනුම්දීම් සක්‍රියයි."
	}
	sent, err := s.deps.Push.Send(r.Context(), user.ID, m)
	if err != nil {
		serverError(w, "push test", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"sent": sent})
}

// --- the notification list (bell and app icon badge) -----------------------

func (s *Server) notificationList(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	if s.deps.Push == nil {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"notifications": []push.Notification{}, "unread": 0})
		return
	}
	list, unread, err := s.deps.Push.Notifications(r.Context(), user.ID, push.ListLimit)
	if err != nil {
		serverError(w, "list notifications", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"notifications": list, "unread": unread})
}

func (s *Server) notificationsRead(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []string `json:"ids"`
		All bool     `json:"all"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	if s.deps.Push == nil {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"unread": 0})
		return
	}
	user, _ := auth.UserFrom(r.Context())
	unread, err := s.deps.Push.MarkRead(r.Context(), user.ID, body.IDs, body.All)
	if err != nil {
		serverError(w, "mark notifications read", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"unread": unread})
}

// notificationPresence is the open app's heartbeat. While visible it says
// so every ~20 seconds (with this browser's push endpoint, when subscribed)
// and gets back the unread count and the newest notification's ID, so it
// can show new ones as toasts. When hidden it says so once, and pushes to
// that browser resume at once.
func (s *Server) notificationPresence(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Visible  bool   `json:"visible"`
		Endpoint string `json:"endpoint"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	if s.deps.Push == nil {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"unread": 0, "latest": ""})
		return
	}
	user, _ := auth.UserFrom(r.Context())
	s.deps.Push.SetForeground(user.ID, body.Endpoint, body.Visible)
	unread, err := s.deps.Push.Unread(r.Context(), user.ID)
	if err != nil {
		serverError(w, "notification presence", err)
		return
	}
	latest, err := s.deps.Push.Latest(r.Context(), user.ID)
	if err != nil {
		serverError(w, "notification presence", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"unread": unread, "latest": latest})
}
