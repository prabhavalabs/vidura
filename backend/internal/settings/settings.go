// Package settings stores the admin-tunable options in app_settings.
package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// Engines the transcription agent can be asked to use.
var Engines = map[string]bool{"parakeet": true, "phonon": true, "whisper": true}

// AITasks are the AI steps whose model and effort can be set separately.
var AITasks = []string{"summary", "translate", "chat"}

// effortPattern is the shape of a reasoning level. Which levels a model
// supports comes from the Codex model catalog, checked by the API handler.
var effortPattern = regexp.MustCompile(`^[a-z]{2,12}$`)

var modelPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,63}$`)

// TaskConfig is the model and reasoning effort one AI task uses.
type TaskConfig struct {
	Model  string `json:"model"`
	Effort string `json:"effort"`
}

// Settings are the values the admin portal edits.
type Settings struct {
	// ASRFallback sends videos without captions to a paired Mac.
	ASRFallback bool `json:"asrFallback"`
	// ASREngine is the speech-to-text engine the Mac should use.
	ASREngine string `json:"asrEngine"`
	// AI holds the model and effort per AI task.
	AI map[string]TaskConfig `json:"ai"`
}

// Defaults apply until a superuser changes something.
var Defaults = Settings{
	ASRFallback: true,
	ASREngine:   "parakeet",
	AI: map[string]TaskConfig{
		"summary":   {Model: "gpt-6.1-sol", Effort: "medium"},
		"translate": {Model: "gpt-6.1-sol", Effort: "low"},
		"chat":      {Model: "gpt-6-luna", Effort: "low"},
	},
}

// Update is a partial change; nil fields stay as they are.
type Update struct {
	ASRFallback *bool                 `json:"asrFallback"`
	ASREngine   *string               `json:"asrEngine"`
	AI          map[string]TaskConfig `json:"ai"`
}

// ErrInvalid is returned for an unknown engine or an empty update.
var ErrInvalid = errors.New("invalid settings")

// Store reads and writes settings.
type Store struct{ db *sql.DB }

// NewStore returns a Store.
func NewStore(database *sql.DB) *Store { return &Store{db: database} }

const (
	keyASRFallback = "asr.fallback"
	keyASREngine   = "asr.engine"
	keyAIPrefix    = "ai.task."
)

// Get returns the current settings with defaults filled in.
func (s *Store) Get(ctx context.Context) (Settings, error) {
	out := Defaults
	out.AI = map[string]TaskConfig{}
	for task, config := range Defaults.AI {
		out.AI[task] = config
	}
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM app_settings`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return out, err
		}
		switch key {
		case keyASRFallback:
			_ = json.Unmarshal([]byte(value), &out.ASRFallback)
		case keyASREngine:
			var engine string
			if json.Unmarshal([]byte(value), &engine) == nil && Engines[engine] {
				out.ASREngine = engine
			}
		default:
			if task, ok := strings.CutPrefix(key, keyAIPrefix); ok {
				var config TaskConfig
				if _, known := out.AI[task]; known && json.Unmarshal([]byte(value), &config) == nil {
					out.AI[task] = config
				}
			}
		}
	}
	return out, rows.Err()
}

// Apply validates and saves an update, returning the new settings and the
// keys that changed.
func (s *Store) Apply(ctx context.Context, actorID string, update Update) (Settings, []string, error) {
	values := map[string]any{}
	if update.ASRFallback != nil {
		values[keyASRFallback] = *update.ASRFallback
	}
	if update.ASREngine != nil {
		if !Engines[*update.ASREngine] {
			return Settings{}, nil, fmt.Errorf("%w: unknown engine %q", ErrInvalid, *update.ASREngine)
		}
		values[keyASREngine] = *update.ASREngine
	}
	for task, config := range update.AI {
		if _, known := Defaults.AI[task]; !known {
			return Settings{}, nil, fmt.Errorf("%w: unknown AI task %q", ErrInvalid, task)
		}
		if !modelPattern.MatchString(config.Model) || !effortPattern.MatchString(config.Effort) {
			return Settings{}, nil, fmt.Errorf("%w: bad model or effort for %s", ErrInvalid, task)
		}
		values[keyAIPrefix+task] = config
	}
	if len(values) == 0 {
		return Settings{}, nil, fmt.Errorf("%w: nothing to change", ErrInvalid)
	}
	now := db.FormatTime(time.Now())
	var changed []string
	for key, value := range values {
		encoded, _ := json.Marshal(value)
		if _, err := s.db.ExecContext(ctx, `INSERT INTO app_settings (key, value, updated_by, updated_at)
			VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value,
			updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
			key, string(encoded), actorID, now); err != nil {
			return Settings{}, nil, err
		}
		changed = append(changed, key)
	}
	current, err := s.Get(ctx)
	return current, changed, err
}
