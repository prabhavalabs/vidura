package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/httpx"
)

func (s *Server) adminRoutes(mux *http.ServeMux) {
	su := s.deps.Auth.RequireSuperuser
	mux.HandleFunc("GET /admin/api/overview", su(s.adminOverview))
	mux.HandleFunc("GET /admin/api/users", su(s.adminListUsers))
	mux.HandleFunc("PATCH /admin/api/users/{id}", su(s.adminUpdateUser))
	mux.HandleFunc("DELETE /admin/api/users/{id}", su(s.adminDeleteUser))
	mux.HandleFunc("GET /admin/api/invites", su(s.adminListInvites))
	mux.HandleFunc("POST /admin/api/invites", su(s.adminCreateInvite))
	mux.HandleFunc("DELETE /admin/api/invites/{email}", su(s.adminDeleteInvite))
	mux.HandleFunc("GET /admin/api/audit", su(s.adminAudit))
}

func (s *Server) adminOverview(w http.ResponseWriter, r *http.Request) {
	counts, err := s.deps.Accounts.CountAccounts(r.Context())
	if err != nil {
		serverError(w, "count accounts", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"accounts": map[string]int{
			"users":          counts.Users,
			"active":         counts.Active,
			"disabled":       counts.Disabled,
			"superusers":     counts.Superusers,
			"pendingInvites": counts.PendingInvites,
			"activeSessions": counts.ActiveSessions,
		},
		"server": map[string]any{
			"version":   s.deps.Version,
			"env":       s.deps.Config.Env,
			"startedAt": s.started.UTC(),
			"uptimeSec": int64(time.Since(s.started).Seconds()),
		},
	})
}

func (s *Server) adminListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.deps.Accounts.ListUsers(r.Context())
	if err != nil {
		serverError(w, "list users", err)
		return
	}
	out := make([]map[string]any, 0, len(users))
	for _, user := range users {
		item := auth.PublicUser(user.User)
		item["activeSessions"] = user.ActiveSessions
		out = append(out, item)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"users": out})
}

func (s *Server) adminUpdateUser(w http.ResponseWriter, r *http.Request) {
	actor, _ := auth.UserFrom(r.Context())
	var body struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	if body.Role == nil && body.Status == nil {
		httpx.WriteError(w, http.StatusBadRequest, "nothing_to_change", "Send a role or a status.")
		return
	}
	before, err := s.deps.Accounts.GetUser(r.Context(), r.PathValue("id"))
	if err != nil {
		accountError(w, err)
		return
	}
	user, err := s.deps.Accounts.UpdateUser(r.Context(), actor, before.ID, accounts.UserUpdate{Role: body.Role, Status: body.Status})
	if err != nil {
		accountError(w, err)
		return
	}
	detail := map[string]any{}
	if before.Role != user.Role {
		detail["role"] = map[string]string{"from": before.Role, "to": user.Role}
	}
	if before.Status != user.Status {
		detail["status"] = map[string]string{"from": before.Status, "to": user.Status}
	}
	s.record(r, actor, audit.UserUpdated, user.Email, detail)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"user": auth.PublicUser(user)})
}

func (s *Server) adminDeleteUser(w http.ResponseWriter, r *http.Request) {
	actor, _ := auth.UserFrom(r.Context())
	deleted, err := s.deps.Accounts.DeleteUser(r.Context(), actor, r.PathValue("id"))
	if err != nil {
		accountError(w, err)
		return
	}
	s.record(r, actor, audit.UserDeleted, deleted.Email, map[string]any{"userId": deleted.ID})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) adminListInvites(w http.ResponseWriter, r *http.Request) {
	invites, err := s.deps.Accounts.ListInvites(r.Context())
	if err != nil {
		serverError(w, "list invites", err)
		return
	}
	out := make([]map[string]any, 0, len(invites))
	for _, invite := range invites {
		out = append(out, publicInvite(invite))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"invites": out})
}

func (s *Server) adminCreateInvite(w http.ResponseWriter, r *http.Request) {
	actor, _ := auth.UserFrom(r.Context())
	var body struct {
		Email string `json:"email"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	email, err := s.deps.Accounts.CreateInvite(r.Context(), actor, body.Email)
	if err != nil {
		accountError(w, err)
		return
	}
	s.record(r, actor, audit.InviteCreated, email, nil)
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"invite": publicInvite(accounts.Invite{
		Email: email, CreatedAt: time.Now().UTC(),
		InvitedBy: &accounts.User{ID: actor.ID, Email: actor.Email, Name: actor.Name},
	})})
}

func (s *Server) adminDeleteInvite(w http.ResponseWriter, r *http.Request) {
	actor, _ := auth.UserFrom(r.Context())
	email, err := s.deps.Accounts.DeleteInvite(r.Context(), r.PathValue("email"))
	if err != nil {
		accountError(w, err)
		return
	}
	s.record(r, actor, audit.InviteDeleted, email, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) adminAudit(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	page, err := s.deps.Audit.List(r.Context(), limit, query.Get("cursor"), query.Get("action"))
	if err != nil {
		serverError(w, "list audit log", err)
		return
	}
	entries := make([]map[string]any, 0, len(page.Entries))
	for _, entry := range page.Entries {
		entries = append(entries, map[string]any{
			"id":         strconv.FormatInt(entry.ID, 10),
			"at":         entry.At,
			"actorId":    entry.ActorID,
			"actorEmail": entry.ActorEmail,
			"action":     entry.Action,
			"target":     entry.Target,
			"detail":     entry.Detail,
			"ip":         entry.IP,
		})
	}
	var next any
	if page.NextCursor != "" {
		next = page.NextCursor
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"entries": entries, "nextCursor": next})
}

func publicInvite(invite accounts.Invite) map[string]any {
	var invitedBy any
	if invite.InvitedBy != nil {
		invitedBy = map[string]string{
			"id": invite.InvitedBy.ID, "email": invite.InvitedBy.Email, "name": invite.InvitedBy.Name,
		}
	}
	return map[string]any{
		"email":     invite.Email,
		"createdAt": invite.CreatedAt,
		"invitedBy": invitedBy,
		"accepted":  invite.AcceptedBy != nil,
	}
}

func (s *Server) record(r *http.Request, actor accounts.User, action, target string, detail map[string]any) {
	s.deps.Audit.Record(r.Context(), audit.Entry{
		ActorID: actor.ID, ActorEmail: actor.Email, Action: action, Target: target,
		Detail: detail, IP: httpx.ClientIP(r, s.deps.Config.TrustProxy),
	})
}

func accountError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, accounts.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "Not found.")
	case errors.Is(err, accounts.ErrConflict):
		httpx.WriteError(w, http.StatusConflict, "already_exists", "That email is already invited.")
	case errors.Is(err, accounts.ErrInvalidEmail):
		httpx.WriteError(w, http.StatusBadRequest, "invalid_email", "Enter a single valid email address.")
	case errors.Is(err, accounts.ErrForbidden):
		httpx.WriteError(w, http.StatusForbidden, "forbidden", forbiddenMessage(err))
	default:
		serverError(w, "account operation", err)
	}
}

func forbiddenMessage(err error) string {
	message := err.Error()
	prefix := accounts.ErrForbidden.Error() + ": "
	message = strings.TrimPrefix(message, prefix)
	if message == "" {
		return "Not permitted."
	}
	return strings.ToUpper(message[:1]) + message[1:] + "."
}

func serverError(w http.ResponseWriter, what string, err error) {
	slog.Error(what, "error", err)
	httpx.WriteError(w, http.StatusInternalServerError, "server_error", "Something went wrong.")
}
