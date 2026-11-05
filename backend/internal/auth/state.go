package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// flowState is what the browser carries between /auth/google/start and the
// callback, in an HMAC-signed cookie. It binds the callback to the browser
// that started the sign-in (state), keeps the PKCE verifier off the URL, and
// holds the nonce the ID token must echo.
type flowState struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	Nonce    string `json:"n"`
	Next     string `json:"r"`
	Expires  int64  `json:"e"`
}

const flowStateTTL = 10 * time.Minute

var errBadState = errors.New("sign-in state is missing, expired or tampered with")

func newFlowState(next string, now time.Time) (flowState, error) {
	state, err := randomString(32)
	if err != nil {
		return flowState{}, err
	}
	verifier, err := randomString(48)
	if err != nil {
		return flowState{}, err
	}
	nonce, err := randomString(32)
	if err != nil {
		return flowState{}, err
	}
	return flowState{State: state, Verifier: verifier, Nonce: nonce, Next: next, Expires: now.Add(flowStateTTL).Unix()}, nil
}

func signFlowState(secret []byte, state flowState) (string, error) {
	payload, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac(secret, encoded)), nil
}

func verifyFlowState(secret []byte, value string, now time.Time) (flowState, error) {
	encoded, signature, ok := strings.Cut(value, ".")
	if !ok {
		return flowState{}, errBadState
	}
	given, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || !hmac.Equal(given, mac(secret, encoded)) {
		return flowState{}, errBadState
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return flowState{}, errBadState
	}
	var state flowState
	if err := json.Unmarshal(payload, &state); err != nil || state.State == "" || state.Verifier == "" || state.Nonce == "" {
		return flowState{}, errBadState
	}
	if now.Unix() > state.Expires {
		return flowState{}, errBadState
	}
	return state, nil
}

func mac(secret []byte, message string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte("vidura-oauth-state\x00"))
	h.Write([]byte(message))
	return h.Sum(nil)
}

func randomString(bytes int) (string, error) {
	raw := make([]byte, bytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// SafeNext returns next if it is a same-site relative path, otherwise "/".
// It blocks open redirects such as "//evil.example", "/\evil.example" and
// absolute URLs.
func SafeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") ||
		strings.ContainsAny(next, "\\\r\n\t") || len(next) > 512 {
		return "/"
	}
	return next
}
