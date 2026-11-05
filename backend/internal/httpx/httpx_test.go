package httpx

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestClientIPOnlyTrustsTheProxyHop(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.2:5555"
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 198.51.100.7")

	assert.Equal(t, "10.0.0.2", ClientIP(r, false), "headers ignored unless a proxy is trusted")
	assert.Equal(t, "198.51.100.7", ClientIP(r, true), "the right-most entry was added by our proxy")

	r.Header.Set("X-Forwarded-For", "garbage")
	assert.Equal(t, "10.0.0.2", ClientIP(r, true))
}

func TestDecodeJSONRejectsUnsafeBodies(t *testing.T) {
	type body struct {
		Email string `json:"email"`
	}
	cases := map[string]struct {
		contentType string
		payload     string
		status      int
	}{
		"ok":            {"application/json", `{"email":"a@b.c"}`, 0},
		"wrong type":    {"text/plain", `{"email":"a@b.c"}`, http.StatusUnsupportedMediaType},
		"unknown field": {"application/json", `{"email":"a@b.c","role":"superuser"}`, http.StatusBadRequest},
		"trailing data": {"application/json", `{"email":"a@b.c"}{}`, http.StatusBadRequest},
		"too large":     {"application/json", `{"email":"` + strings.Repeat("a", MaxBodyBytes) + `"}`, http.StatusRequestEntityTooLarge},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.payload))
			r.Header.Set("Content-Type", tc.contentType)
			w := httptest.NewRecorder()
			var dst body
			ok := DecodeJSON(w, r, &dst)
			if tc.status == 0 {
				assert.True(t, ok)
				assert.Equal(t, "a@b.c", dst.Email)
				return
			}
			assert.False(t, ok)
			assert.Equal(t, tc.status, w.Code)
		})
	}
}

func TestRateLimiterWindows(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := NewRateLimiter(2, time.Minute)
	limiter.now = func() time.Time { return now }

	assert.True(t, limiter.Allow("a"))
	assert.True(t, limiter.Allow("a"))
	assert.False(t, limiter.Allow("a"))
	assert.True(t, limiter.Allow("b"), "keys are independent")

	now = now.Add(time.Minute)
	assert.True(t, limiter.Allow("a"), "a new window resets the count")
}
