// Package agentproto is the wire format between the Vidura server and the
// transcription agent on the owner's Mac. Both sides import it, so a change
// here changes both.
//
// The agent always dials out: it pairs once with a single-use code
// (POST PairPath), then holds a WebSocket (ConnectPath) authenticated with
// its device token. Messages are JSON objects with a "type".
package agentproto

import "regexp"

// Paths on the API host.
const (
	PairPath    = "/agent/v1/pair"
	ConnectPath = "/agent/v1/connect"
)

// TokenPrefix marks device tokens so they're recognisable in logs and leak
// scanners.
const TokenPrefix = "vd_dev_"

// HeartbeatSeconds is how often the agent says it's alive; the server drops
// a connection that is silent for three heartbeats.
const HeartbeatSeconds = 15

// Message types.
const (
	TypeHello     = "hello"
	TypeHeartbeat = "heartbeat"
	TypeWelcome   = "welcome"
	// TypeInstall asks the agent to install an engine and download its
	// model (server → agent). The agent maps the engine id to a fixed recipe;
	// the server can't send commands.
	TypeInstall = "engine.install"
	// TypeInstallStatus reports install progress (agent → server).
	TypeInstallStatus = "engine.status"
	// TypeTranscribe asks for one video's English transcript (server →
	// agent). It carries only a YouTube id and an engine id; the agent runs
	// its own fixed download and transcription commands.
	TypeTranscribe = "transcribe.request"
	// TypeTranscribeCancel stops a transcription (server → agent).
	TypeTranscribeCancel = "transcribe.cancel"
	// TypeTranscribeProgress reports progress (agent → server).
	TypeTranscribeProgress = "transcribe.progress"
	// TypeTranscribeResult returns the segments (agent → server).
	TypeTranscribeResult = "transcribe.result"
	// TypeTranscribeFailed reports a failure (agent → server).
	TypeTranscribeFailed = "transcribe.failed"
	// TypeSpeech asks for the words in a short recording, a spoken question
	// (server → agent). It carries the audio and its type (one of
	// SpeechFormats); the agent runs its own fixed Whisper command.
	TypeSpeech = "speech.request"
	// TypeSpeechResult returns the words and their language (agent → server).
	TypeSpeechResult = "speech.result"
	// TypeSpeechFailed reports a failure (agent → server).
	TypeSpeechFailed = "speech.failed"
)

// SpeechEngine is the engine that understands spoken questions: Whisper
// large-v3, which knows Sinhala far better than the turbo model.
const SpeechEngine = "speech"

// MaxSpeechBytes bounds a spoken question's recording (about two minutes).
const MaxSpeechBytes = 5 << 20

// SpeechFormats maps the audio types a browser records to the file
// extension the agent saves them with. Nothing else is accepted.
var SpeechFormats = map[string]string{
	"audio/webm": "webm",
	"audio/ogg":  "ogg",
	"audio/mp4":  "m4a",
	"audio/aac":  "aac",
	"audio/mpeg": "mp3",
	"audio/wav":  "wav",
}

// MaxMessageBytes bounds one frame; a transcription result is the largest.
const MaxMessageBytes = 16 << 20

// MaxSegments bounds the segments in one transcription result.
const MaxSegments = 50_000

// YouTubeID matches a YouTube video id, the only input a transcription takes.
var YouTubeID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// Segment is one timed piece of a transcript.
type Segment struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
}

// Install states.
const (
	InstallQueued     = "queued"
	InstallInstalling = "installing"
	InstallReady      = "ready"
	InstallFailed     = "failed"
)

// Engines the agent knows how to install.
var Engines = map[string]bool{"parakeet": true, "phonon": true, "whisper": true, SpeechEngine: true}

// PairRequest exchanges a pairing code for a device token.
type PairRequest struct {
	Code         string `json:"code"`
	Name         string `json:"name"`
	Hostname     string `json:"hostname"`
	Platform     string `json:"platform"`
	AgentVersion string `json:"agentVersion"`
}

// PairResponse carries the device token. It is shown once and only its hash
// is kept on the server.
type PairResponse struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	Token    string `json:"token"`
}

// Engine is a speech-to-text engine the agent can run.
type Engine struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Ready  bool   `json:"ready"`
	Detail string `json:"detail"`
}

// Capabilities describe the agent's machine and what it can run.
type Capabilities struct {
	AgentVersion string          `json:"agentVersion"`
	Hostname     string          `json:"hostname"`
	OS           string          `json:"os"`
	Arch         string          `json:"arch"`
	Engines      []Engine        `json:"engines"`
	Tools        map[string]bool `json:"tools"`
}

// Message is one frame in either direction.
type Message struct {
	Type string `json:"type"`
	// Hello (agent → server).
	Capabilities *Capabilities `json:"capabilities,omitempty"`
	// Welcome (server → agent).
	DeviceID string `json:"deviceId,omitempty"`
	Name     string `json:"name,omitempty"`
	// Install and install status.
	Engine string `json:"engine,omitempty"`
	State  string `json:"state,omitempty"`
	Detail string `json:"detail,omitempty"`
	// Transcription.
	RequestID string    `json:"requestId,omitempty"`
	YouTubeID string    `json:"youtubeId,omitempty"`
	Percent   int       `json:"percent,omitempty"`
	Segments  []Segment `json:"segments,omitempty"`
	// Speech: the recording (server → agent), the words and their language
	// (agent → server).
	Audio     []byte `json:"audio,omitempty"`
	AudioType string `json:"audioType,omitempty"`
	Text      string `json:"text,omitempty"`
	Language  string `json:"language,omitempty"`
}
