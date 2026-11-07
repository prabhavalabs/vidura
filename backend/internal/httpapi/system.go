package httpapi

import (
	"context"
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/agenthub"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/httpx"
	"github.com/prabhavalabs/vidura/backend/internal/settings"
)

func (s *Server) systemRoutes(mux *http.ServeMux) {
	su := s.deps.Auth.RequireSuperuser
	mux.HandleFunc("GET /api/admin/system", su(s.adminSystem))

	mux.HandleFunc("GET /api/admin/ai", su(s.aiStatus))
	mux.HandleFunc("POST /api/admin/ai/login", su(s.aiStartLogin))
	mux.HandleFunc("DELETE /api/admin/ai/login", su(s.aiCancelLogin))
	mux.HandleFunc("POST /api/admin/ai/logout", su(s.aiLogout))
	mux.HandleFunc("POST /api/admin/ai/test", su(s.aiTest))
	mux.HandleFunc("GET /api/admin/ai/models", su(s.aiModels))

	mux.HandleFunc("GET /api/admin/devices", su(s.listDevices))
	mux.HandleFunc("POST /api/admin/devices/pairing-codes", su(s.createPairingCode))
	mux.HandleFunc("DELETE /api/admin/devices/{id}", su(s.revokeDevice))
	mux.HandleFunc("POST /api/admin/devices/{id}/engines/{engine}/install", su(s.installEngine))

	mux.HandleFunc("GET /api/admin/settings", su(s.getSettings))
	mux.HandleFunc("PATCH /api/admin/settings", su(s.patchSettings))
}

// adminSystem reports the server itself.
func (s *Server) adminSystem(w http.ResponseWriter, r *http.Request) {
	var dbBytes int64
	for _, suffix := range []string{"", "-wal"} {
		if info, err := os.Stat(s.deps.Config.DatabasePath() + suffix); err == nil {
			dbBytes += info.Size()
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"server": map[string]any{
			"version":   s.deps.Version,
			"env":       s.deps.Config.Env,
			"startedAt": s.started.UTC().Format(time.RFC3339),
			"uptimeSec": int64(time.Since(s.started).Seconds()),
		},
		"database": map[string]any{"sizeBytes": dbBytes},
		"urls": map[string]string{
			"api":    s.deps.Config.APIOrigin(),
			"admin":  s.deps.Config.AdminOrigin(),
			"client": s.deps.Config.ClientOrigin(),
		},
		"agentsOnline": s.hub.OnlineCount(),
	})
}

// --- ChatGPT --------------------------------------------------------------

func (s *Server) aiStatus(w http.ResponseWriter, r *http.Request) {
	if s.deps.ChatGPT == nil {
		httpx.WriteJSON(w, http.StatusOK, chatgpt.Status{State: chatgpt.StateNotInstalled, CheckedAt: time.Now()})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, s.deps.ChatGPT.Status(r.Context(), r.URL.Query().Get("fresh") == "1"))
}

func (s *Server) aiStartLogin(w http.ResponseWriter, r *http.Request) {
	if s.deps.ChatGPT == nil {
		httpx.WriteError(w, http.StatusServiceUnavailable, "not_installed", chatgpt.ErrNotInstalled.Error())
		return
	}
	actor, _ := auth.UserFrom(r.Context())
	login, err := s.deps.ChatGPT.StartLogin(r.Context(), actor.Email)
	if errors.Is(err, chatgpt.ErrNotInstalled) {
		httpx.WriteError(w, http.StatusServiceUnavailable, "not_installed", err.Error())
		return
	}
	if err != nil {
		httpx.WriteError(w, http.StatusBadGateway, "login_failed", err.Error())
		return
	}
	s.recordAsActor(r, audit.AIConnectStarted, "", nil)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"login": login})
}

func (s *Server) aiCancelLogin(w http.ResponseWriter, _ *http.Request) {
	if s.deps.ChatGPT != nil {
		s.deps.ChatGPT.CancelLogin()
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) aiLogout(w http.ResponseWriter, r *http.Request) {
	if s.deps.ChatGPT == nil {
		httpx.WriteError(w, http.StatusServiceUnavailable, "not_installed", chatgpt.ErrNotInstalled.Error())
		return
	}
	if err := s.deps.ChatGPT.Logout(r.Context()); err != nil {
		httpx.WriteError(w, http.StatusBadGateway, "logout_failed", err.Error())
		return
	}
	s.recordAsActor(r, audit.AIDisconnected, "", nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) aiTest(w http.ResponseWriter, r *http.Request) {
	if s.deps.ChatGPT == nil {
		httpx.WriteError(w, http.StatusServiceUnavailable, "not_installed", chatgpt.ErrNotInstalled.Error())
		return
	}
	result, err := s.deps.ChatGPT.Test(r.Context())
	switch {
	case errors.Is(err, chatgpt.ErrNotConnected):
		httpx.WriteError(w, http.StatusConflict, "not_connected", err.Error())
	case err != nil:
		httpx.WriteError(w, http.StatusBadGateway, "test_failed", err.Error())
	default:
		httpx.WriteJSON(w, http.StatusOK, result)
	}
}

func (s *Server) aiModels(w http.ResponseWriter, r *http.Request) {
	if s.deps.ChatGPT == nil {
		httpx.WriteError(w, http.StatusServiceUnavailable, "not_installed", chatgpt.ErrNotInstalled.Error())
		return
	}
	models, err := s.deps.ChatGPT.Models(r.Context())
	if err != nil {
		httpx.WriteError(w, http.StatusBadGateway, "models_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"models": models})
}

// AILoginRecorder returns the callback the ChatGPT manager calls when a
// device sign-in finishes, so the outcome lands in the audit log.
func AILoginRecorder(log *audit.Log) func(startedBy string, err error) {
	return func(startedBy string, err error) {
		entry := audit.Entry{ActorEmail: startedBy, Action: audit.AIConnected}
		if err != nil {
			entry.Action = audit.AIConnectFailed
		}
		log.Record(context.Background(), entry)
	}
}

// --- devices --------------------------------------------------------------

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := s.hub.ListDevices(r.Context())
	if err != nil {
		serverError(w, "list devices", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (s *Server) createPairingCode(w http.ResponseWriter, r *http.Request) {
	actor, _ := auth.UserFrom(r.Context())
	code, err := s.hub.CreatePairingCode(r.Context(), actor, s.clientIP(r))
	if err != nil {
		serverError(w, "create pairing code", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{
		"pairing":   code,
		"serverUrl": s.deps.Config.APIOrigin(),
	})
}

func (s *Server) installEngine(w http.ResponseWriter, r *http.Request) {
	actor, _ := auth.UserFrom(r.Context())
	err := s.hub.InstallEngine(r.Context(), actor, r.PathValue("id"), r.PathValue("engine"), s.clientIP(r))
	switch {
	case errors.Is(err, agenthub.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "No such device.")
	case errors.Is(err, agenthub.ErrUnknownEngine):
		httpx.WriteError(w, http.StatusBadRequest, "unknown_engine", err.Error())
	case errors.Is(err, agenthub.ErrOffline):
		httpx.WriteError(w, http.StatusConflict, "offline", err.Error())
	case err != nil:
		serverError(w, "install engine", err)
	default:
		w.WriteHeader(http.StatusAccepted)
	}
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request) {
	actor, _ := auth.UserFrom(r.Context())
	err := s.hub.Revoke(r.Context(), actor, r.PathValue("id"), s.clientIP(r))
	if errors.Is(err, agenthub.ErrNotFound) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "No such device.")
		return
	}
	if err != nil {
		serverError(w, "revoke device", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- settings -------------------------------------------------------------

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	current, err := s.settings.Get(r.Context())
	if err != nil {
		serverError(w, "get settings", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, current)
}

func (s *Server) patchSettings(w http.ResponseWriter, r *http.Request) {
	var update settings.Update
	if !httpx.DecodeJSON(w, r, &update) {
		return
	}
	// When the CLI is available, a model must be one it lists, with an
	// effort that model supports.
	if len(update.AI) > 0 && s.deps.ChatGPT != nil {
		if models, err := s.deps.ChatGPT.Models(r.Context()); err == nil {
			for task, config := range update.AI {
				if !supports(models, config) {
					httpx.WriteError(w, http.StatusBadRequest, "invalid_settings",
						"The "+task+" model doesn't support that effort level, or isn't available.")
					return
				}
			}
		}
	}
	actor, _ := auth.UserFrom(r.Context())
	current, changed, err := s.settings.Apply(r.Context(), actor.ID, update)
	if errors.Is(err, settings.ErrInvalid) {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_settings", err.Error())
		return
	}
	if err != nil {
		serverError(w, "update settings", err)
		return
	}
	s.recordAsActor(r, audit.SettingsUpdated, "", map[string]any{"changed": changed, "settings": current})
	httpx.WriteJSON(w, http.StatusOK, current)
}

// --- helpers --------------------------------------------------------------

func supports(models []chatgpt.Model, config settings.TaskConfig) bool {
	for _, model := range models {
		if model.Slug == config.Model {
			for _, effort := range model.Efforts {
				if effort == config.Effort {
					return true
				}
			}
			return false
		}
	}
	return false
}

func (s *Server) clientIP(r *http.Request) string {
	return httpx.ClientIP(r, s.deps.Config.TrustProxy)
}

func (s *Server) recordAsActor(r *http.Request, action, target string, detail map[string]any) {
	actor, _ := auth.UserFrom(r.Context())
	s.deps.Audit.Record(r.Context(), audit.Entry{
		ActorID: actor.ID, ActorEmail: actor.Email, Action: action, Target: target, IP: s.clientIP(r), Detail: detail,
	})
}
