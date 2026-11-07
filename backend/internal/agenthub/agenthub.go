// Package agenthub pairs transcription agents and keeps their live
// connections.
//
// Security model (the agent runs on the owner's personal Mac):
//   - The agent only ever dials out; the Mac opens no ports.
//   - Pairing needs a single-use code a superuser created in the admin
//     portal in the last ten minutes. Codes and device tokens are stored as
//     SHA-256 hashes, so a database leak reveals neither.
//   - Requests that carry an Origin header (that is, come from a browser)
//     are refused, so no web page can pair or impersonate an agent.
//   - Revoking a device kills its connection and its token at once.
//   - Messages are size-limited, and an agent silent for three heartbeats is
//     dropped.
package agenthub

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/httpx"
)

// PairingCodeTTL is how long a pairing code works.
const PairingCodeTTL = 10 * time.Minute

// Errors for device operations.
var (
	// ErrNotFound is returned for an unknown or already revoked device.
	ErrNotFound = errors.New("device not found")
	// ErrOffline is returned when a device must be connected for an action.
	ErrOffline = errors.New("the Mac is offline; start the agent and try again")
	// ErrUnknownEngine is returned for an engine id the agent can't install.
	ErrUnknownEngine = errors.New("unknown engine")
)

// Install is the progress of one engine install on one device.
type Install struct {
	State     string    `json:"state"`
	Detail    string    `json:"detail"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Device is a paired agent as the admin portal shows it.
type Device struct {
	ID           string                   `json:"id"`
	Name         string                   `json:"name"`
	Hostname     string                   `json:"hostname"`
	Platform     string                   `json:"platform"`
	AgentVersion string                   `json:"agentVersion"`
	Capabilities *agentproto.Capabilities `json:"capabilities"`
	PairedBy     *string                  `json:"pairedBy"`
	CreatedAt    string                   `json:"createdAt"`
	LastSeenAt   *string                  `json:"lastSeenAt"`
	LastIP       string                   `json:"lastIp"`
	Online       bool                     `json:"online"`
	ConnectedAt  *string                  `json:"connectedAt"`
	// Installs are engine installs started since the server last restarted.
	Installs map[string]Install `json:"installs"`
}

// PairingCode is a freshly created code, shown once.
type PairingCode struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Hub tracks paired devices and their connections.
type Hub struct {
	db         *sql.DB
	audit      *audit.Log
	trustProxy bool
	limiter    *httpx.RateLimiter
	now        func() time.Time

	mu       sync.Mutex
	sessions map[string]*session
	installs map[string]map[string]Install
	pending  map[string]*transcription
}

type session struct {
	conn        *websocket.Conn
	cancel      context.CancelFunc
	connectedAt time.Time
	// ready lists the engines the agent last reported as ready.
	ready map[string]bool
}

// New returns a Hub.
func New(database *sql.DB, auditLog *audit.Log, trustProxy bool) *Hub {
	return &Hub{
		db: database, audit: auditLog, trustProxy: trustProxy,
		limiter:  httpx.NewRateLimiter(10, time.Minute),
		now:      time.Now,
		sessions: map[string]*session{},
		installs: map[string]map[string]Install{},
		pending:  map[string]*transcription{},
	}
}

// Routes registers the agent endpoints. They don't use cookies; agents
// authenticate with pairing codes and device tokens.
func (h *Hub) Routes(mux *http.ServeMux) {
	mux.HandleFunc("POST "+agentproto.PairPath, h.pair)
	mux.HandleFunc("GET "+agentproto.ConnectPath, h.connect)
}

// Close drops every live connection (server shutdown).
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, s := range h.sessions {
		_ = s.conn.Close(websocket.StatusGoingAway, "server shutting down")
		s.cancel()
		delete(h.sessions, id)
	}
}

// --- admin operations -----------------------------------------------------

const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

// CreatePairingCode makes a single-use code for pairing one agent.
func (h *Hub) CreatePairingCode(ctx context.Context, actor accounts.User, ip string) (PairingCode, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return PairingCode{}, err
	}
	var b strings.Builder
	for i, v := range raw {
		if i == 4 {
			b.WriteByte('-')
		}
		b.WriteByte(codeAlphabet[int(v)%len(codeAlphabet)])
	}
	code := b.String()
	now := h.now()
	expires := now.Add(PairingCodeTTL)
	if _, err := h.db.ExecContext(ctx, `INSERT INTO pairing_codes (code_hash, created_by, created_at, expires_at)
		VALUES (?, ?, ?, ?)`, hashCode(code), actor.ID, db.FormatTime(now), db.FormatTime(expires)); err != nil {
		return PairingCode{}, err
	}
	h.audit.Record(ctx, audit.Entry{ActorID: actor.ID, ActorEmail: actor.Email, Action: audit.DevicePairingCode, IP: ip})
	return PairingCode{Code: code, ExpiresAt: expires}, nil
}

// ListDevices returns active devices, newest first, with live status.
func (h *Hub) ListDevices(ctx context.Context) ([]Device, error) {
	rows, err := h.db.QueryContext(ctx, `SELECT d.id, d.name, d.hostname, d.platform, d.agent_version, d.capabilities,
			u.email, d.created_at, d.last_seen_at, d.last_ip
		FROM devices d LEFT JOIN users u ON u.id = d.paired_by
		WHERE d.revoked_at IS NULL ORDER BY d.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	devices := []Device{}
	for rows.Next() {
		var d Device
		var caps string
		if err := rows.Scan(&d.ID, &d.Name, &d.Hostname, &d.Platform, &d.AgentVersion, &caps,
			&d.PairedBy, &d.CreatedAt, &d.LastSeenAt, &d.LastIP); err != nil {
			return nil, err
		}
		var parsed agentproto.Capabilities
		if json.Unmarshal([]byte(caps), &parsed) == nil && parsed.OS != "" {
			d.Capabilities = &parsed
		}
		devices = append(devices, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range devices {
		devices[i].Installs = map[string]Install{}
		for engine, install := range h.installs[devices[i].ID] {
			devices[i].Installs[engine] = install
		}
		if s, ok := h.sessions[devices[i].ID]; ok {
			devices[i].Online = true
			at := db.FormatTime(s.connectedAt)
			devices[i].ConnectedAt = &at
		}
	}
	return devices, nil
}

// Revoke disables a device's token and drops its connection.
func (h *Hub) Revoke(ctx context.Context, actor accounts.User, id, ip string) error {
	result, err := h.db.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
		db.FormatTime(h.now()), id)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	h.mu.Lock()
	if s, ok := h.sessions[id]; ok {
		_ = s.conn.Close(websocket.StatusPolicyViolation, "device revoked")
		s.cancel()
		delete(h.sessions, id)
	}
	h.mu.Unlock()
	h.audit.Record(ctx, audit.Entry{ActorID: actor.ID, ActorEmail: actor.Email, Action: audit.DeviceRevoked, Target: id, IP: ip})
	return nil
}

// InstallEngine asks a connected device to install an engine and download
// its model. Progress arrives through the device's connection.
func (h *Hub) InstallEngine(ctx context.Context, actor accounts.User, deviceID, engine, ip string) error {
	if !agentproto.Engines[engine] {
		return ErrUnknownEngine
	}
	h.mu.Lock()
	s, ok := h.sessions[deviceID]
	if ok {
		if current, busy := h.installs[deviceID][engine]; busy &&
			(current.State == agentproto.InstallQueued || current.State == agentproto.InstallInstalling) {
			h.mu.Unlock()
			return nil
		}
		h.setInstall(deviceID, engine, agentproto.InstallQueued, "Sent to the Mac")
	}
	h.mu.Unlock()
	if !ok {
		var exists int
		_ = h.db.QueryRowContext(ctx, `SELECT count(*) FROM devices WHERE id = ? AND revoked_at IS NULL`, deviceID).Scan(&exists)
		if exists == 0 {
			return ErrNotFound
		}
		return ErrOffline
	}
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := wsjson.Write(writeCtx, s.conn, agentproto.Message{Type: agentproto.TypeInstall, Engine: engine}); err != nil {
		h.mu.Lock()
		h.setInstall(deviceID, engine, agentproto.InstallFailed, "Couldn't reach the Mac")
		h.mu.Unlock()
		return ErrOffline
	}
	h.audit.Record(ctx, audit.Entry{ActorID: actor.ID, ActorEmail: actor.Email, Action: audit.DeviceEngineInstall,
		Target: deviceID, IP: ip, Detail: map[string]any{"engine": engine}})
	return nil
}

// setInstall records install progress; h.mu must be held.
func (h *Hub) setInstall(deviceID, engine, state, detail string) {
	if h.installs[deviceID] == nil {
		h.installs[deviceID] = map[string]Install{}
	}
	h.installs[deviceID][engine] = Install{State: state, Detail: detail, UpdatedAt: h.now()}
}

// OnlineCount reports how many agents are connected.
func (h *Hub) OnlineCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.sessions)
}

// --- agent endpoints ------------------------------------------------------

func (h *Hub) pair(w http.ResponseWriter, r *http.Request) {
	ip := httpx.ClientIP(r, h.trustProxy)
	if r.Header.Get("Origin") != "" {
		httpx.WriteError(w, http.StatusForbidden, "browser_refused", "Agents don't pair from a browser.")
		return
	}
	if !h.limiter.Allow(ip) {
		httpx.WriteError(w, http.StatusTooManyRequests, "rate_limited", "Too many pairing attempts. Try again in a minute.")
		return
	}
	var req agentproto.PairRequest
	if !httpx.DecodeJSON(w, r, &req) {
		return
	}

	now := h.now()
	tx, err := h.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, "pair: begin", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	var createdBy sql.NullString
	err = tx.QueryRowContext(r.Context(), `UPDATE pairing_codes SET used_at = ?
		WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING created_by`,
		db.FormatTime(now), hashCode(req.Code), db.FormatTime(now)).Scan(&createdBy)
	if errors.Is(err, sql.ErrNoRows) {
		// Release the write lock before the audit log needs it.
		_ = tx.Rollback()
		h.audit.Record(r.Context(), audit.Entry{Action: audit.DevicePairRefused, IP: ip,
			Detail: map[string]any{"hostname": clean(req.Hostname, 80)}})
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_code", "That pairing code is wrong, used or expired. Create a new one in the admin portal.")
		return
	}
	if err != nil {
		serverError(w, "pair: claim code", err)
		return
	}

	token, err := newToken()
	if err != nil {
		serverError(w, "pair: token", err)
		return
	}
	name := clean(req.Name, 60)
	if name == "" {
		name = clean(req.Hostname, 60)
	}
	if name == "" {
		name = "Mac"
	}
	id := uuid.NewString()
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO devices (id, name, token_hash, hostname, platform, agent_version,
			paired_by, created_at, last_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, name, hashToken(token), clean(req.Hostname, 120), clean(req.Platform, 60), clean(req.AgentVersion, 40),
		createdBy, db.FormatTime(now), ip); err != nil {
		serverError(w, "pair: insert", err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE pairing_codes SET device_id = ? WHERE code_hash = ?`,
		id, hashCode(req.Code)); err != nil {
		serverError(w, "pair: link code", err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, "pair: commit", err)
		return
	}
	entry := audit.Entry{Action: audit.DevicePaired, Target: id, IP: ip, Detail: map[string]any{"name": name}}
	if createdBy.Valid {
		entry.ActorID = createdBy.String
	}
	h.audit.Record(r.Context(), entry)
	httpx.WriteJSON(w, http.StatusOK, agentproto.PairResponse{DeviceID: id, Name: name, Token: token})
}

func (h *Hub) connect(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" {
		httpx.WriteError(w, http.StatusForbidden, "browser_refused", "Agents don't connect from a browser.")
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || !strings.HasPrefix(token, agentproto.TokenPrefix) {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthenticated", "Missing device token.")
		return
	}
	var id, name string
	err := h.db.QueryRowContext(r.Context(), `SELECT id, name FROM devices WHERE token_hash = ? AND revoked_at IS NULL`,
		hashToken(token)).Scan(&id, &name)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, http.StatusUnauthorized, "unauthenticated", "Unknown or revoked device token.")
		return
	}
	if err != nil {
		serverError(w, "connect: lookup", err)
		return
	}

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(agentproto.MaxMessageBytes)
	ip := httpx.ClientIP(r, h.trustProxy)
	ctx, cancel := context.WithCancel(context.Background())
	connected := h.now()

	h.mu.Lock()
	if previous, ok := h.sessions[id]; ok {
		_ = previous.conn.Close(websocket.StatusPolicyViolation, "replaced by a newer connection")
		previous.cancel()
	}
	current := &session{conn: conn, cancel: cancel, connectedAt: connected}
	h.sessions[id] = current
	h.mu.Unlock()

	slog.Info("agent connected", "device", id, "name", name)
	h.touch(id, ip, nil)
	defer func() {
		cancel()
		h.mu.Lock()
		if h.sessions[id] == current {
			delete(h.sessions, id)
		}
		h.mu.Unlock()
		h.dropTranscriptions(id, current)
		h.touch(id, ip, nil)
		_ = conn.CloseNow()
		slog.Info("agent disconnected", "device", id)
	}()

	if err := wsjson.Write(ctx, conn, agentproto.Message{Type: agentproto.TypeWelcome, DeviceID: id, Name: name}); err != nil {
		return
	}
	lastWrite := connected
	for {
		readCtx, readCancel := context.WithTimeout(ctx, 3*agentproto.HeartbeatSeconds*time.Second)
		var msg agentproto.Message
		err := wsjson.Read(readCtx, conn, &msg)
		readCancel()
		if err != nil {
			return
		}
		switch msg.Type {
		case agentproto.TypeHello:
			if msg.Capabilities != nil {
				caps := sanitize(msg.Capabilities)
				h.touch(id, ip, caps)
				lastWrite = h.now()
				ready := map[string]bool{}
				for _, engine := range caps.Engines {
					if engine.Ready && agentproto.Engines[engine.ID] {
						ready[engine.ID] = true
					}
				}
				h.mu.Lock()
				current.ready = ready
				h.mu.Unlock()
			}
		case agentproto.TypeTranscribeProgress, agentproto.TypeTranscribeResult, agentproto.TypeTranscribeFailed,
			agentproto.TypeSpeechResult, agentproto.TypeSpeechFailed:
			h.transcriptionMessage(current, msg)
		case agentproto.TypeInstallStatus:
			if agentproto.Engines[msg.Engine] {
				switch msg.State {
				case agentproto.InstallInstalling, agentproto.InstallReady, agentproto.InstallFailed:
					h.mu.Lock()
					h.setInstall(id, msg.Engine, msg.State, clean(msg.Detail, 300))
					h.mu.Unlock()
				}
			}
		case agentproto.TypeHeartbeat:
			// last_seen_at is written at most once a minute.
			if h.now().Sub(lastWrite) > time.Minute {
				h.touch(id, ip, nil)
				lastWrite = h.now()
			}
		}
	}
}

// touch records that the device was seen, and its capabilities if given.
func (h *Hub) touch(id, ip string, caps *agentproto.Capabilities) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	now := db.FormatTime(h.now())
	var err error
	if caps != nil {
		encoded, _ := json.Marshal(caps)
		_, err = h.db.ExecContext(ctx, `UPDATE devices SET last_seen_at = ?, last_ip = ?, capabilities = ?,
			hostname = ?, platform = ?, agent_version = ? WHERE id = ?`,
			now, ip, string(encoded), caps.Hostname, caps.OS+"/"+caps.Arch, caps.AgentVersion, id)
	} else {
		_, err = h.db.ExecContext(ctx, `UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?`, now, ip, id)
	}
	if err != nil {
		slog.Error("agent: record last seen", "device", id, "error", err)
	}
}

// sanitize bounds what an agent can store about itself.
func sanitize(caps *agentproto.Capabilities) *agentproto.Capabilities {
	out := &agentproto.Capabilities{
		AgentVersion: clean(caps.AgentVersion, 40), Hostname: clean(caps.Hostname, 120),
		OS: clean(caps.OS, 30), Arch: clean(caps.Arch, 30), Tools: map[string]bool{},
	}
	for i, engine := range caps.Engines {
		if i >= 8 {
			break
		}
		out.Engines = append(out.Engines, agentproto.Engine{
			ID: clean(engine.ID, 30), Name: clean(engine.Name, 60), Ready: engine.Ready, Detail: clean(engine.Detail, 200),
		})
	}
	count := 0
	for name, ok := range caps.Tools {
		if count >= 8 {
			break
		}
		out.Tools[clean(name, 30)] = ok
		count++
	}
	return out
}

// clean trims, drops control characters and caps the length.
func clean(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	if runes := []rune(value); len(runes) > limit {
		value = string(runes[:limit])
	}
	return value
}

func newToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return agentproto.TokenPrefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte("vidura-device-token\x00" + token))
	return hex.EncodeToString(sum[:])
}

// hashCode normalizes a pairing code (case, dashes, spaces) and hashes it.
func hashCode(code string) string {
	normalized := strings.Map(func(r rune) rune {
		if r == '-' || unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToUpper(r)
	}, code)
	sum := sha256.Sum256([]byte("vidura-pairing-code\x00" + normalized))
	return hex.EncodeToString(sum[:])
}

func serverError(w http.ResponseWriter, what string, err error) {
	slog.Error(what, "error", err)
	httpx.WriteError(w, http.StatusInternalServerError, "server_error", "Something went wrong.")
}
