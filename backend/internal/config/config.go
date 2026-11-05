// Package config reads and validates the process environment once at start-up,
// so a misconfiguration stops the server before it accepts a request.
package config

import (
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Environment names.
const (
	EnvProduction  = "production"
	EnvDevelopment = "development"
)

// Config is the validated runtime configuration.
type Config struct {
	Env       string
	Addr      string
	DataDir   string
	PublicURL *url.URL
	// Secret signs short-lived OAuth state cookies. At least 32 bytes.
	Secret []byte

	GoogleClientID     string
	GoogleClientSecret string

	// SuperuserEmails are always superusers. They can't be demoted, disabled
	// or deleted from the admin portal, so the owner can't be locked out.
	SuperuserEmails map[string]bool

	// DevLogin enables POST /auth/dev-login, which signs in any allowed email
	// without Google. Only permitted when Env is development.
	DevLogin bool

	// TrustProxy makes the server read the client address from the
	// X-Forwarded-For header set by the reverse proxy in front of it.
	TrustProxy bool
}

// DatabasePath is the SQLite file inside the data directory.
func (c *Config) DatabasePath() string { return filepath.Join(c.DataDir, "vidura.db") }

// Production reports whether the server runs in production.
func (c *Config) Production() bool { return c.Env == EnvProduction }

// GoogleEnabled reports whether Google sign-in is configured.
func (c *Config) GoogleEnabled() bool {
	return c.GoogleClientID != "" && c.GoogleClientSecret != ""
}

// SecureCookies reports whether cookies must carry the Secure attribute.
func (c *Config) SecureCookies() bool { return c.PublicURL.Scheme == "https" }

// Origin is the scheme://host[:port] of the public URL, compared against the
// Origin header of state-changing requests.
func (c *Config) Origin() string { return c.PublicURL.Scheme + "://" + c.PublicURL.Host }

// IsSuperuserEmail reports whether email is a configured superuser.
func (c *Config) IsSuperuserEmail(email string) bool {
	return c.SuperuserEmails[NormalizeEmail(email)]
}

// NormalizeEmail lower-cases and trims an email address.
func NormalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

// Load reads the configuration from the environment.
func Load() (*Config, error) { return load(os.Getenv) }

func load(getenv func(string) string) (*Config, error) {
	var problems []string
	get := func(name, fallback string) string {
		if value := strings.TrimSpace(getenv(name)); value != "" {
			return value
		}
		return fallback
	}

	cfg := &Config{
		Env:                get("VIDURA_ENV", EnvProduction),
		Addr:               get("VIDURA_ADDR", ":8790"),
		DataDir:            get("VIDURA_DATA_DIR", "/data"),
		GoogleClientID:     get("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret: get("GOOGLE_CLIENT_SECRET", ""),
		DevLogin:           get("VIDURA_DEV_LOGIN", "false") == "true",
		TrustProxy:         get("VIDURA_TRUST_PROXY", "false") == "true",
		SuperuserEmails:    map[string]bool{},
	}

	if cfg.Env != EnvProduction && cfg.Env != EnvDevelopment {
		problems = append(problems, fmt.Sprintf("VIDURA_ENV must be %q or %q", EnvProduction, EnvDevelopment))
	}

	rawURL := get("VIDURA_PUBLIC_URL", "")
	if rawURL == "" {
		problems = append(problems, "VIDURA_PUBLIC_URL is required (e.g. https://vidura.example.com)")
	} else if parsed, err := url.Parse(rawURL); err != nil || parsed.Host == "" ||
		(parsed.Scheme != "https" && parsed.Scheme != "http") {
		problems = append(problems, "VIDURA_PUBLIC_URL must be an absolute http(s) URL")
	} else {
		parsed.Path = strings.TrimSuffix(parsed.Path, "/")
		cfg.PublicURL = parsed
		if parsed.Scheme == "http" && cfg.Env == EnvProduction {
			problems = append(problems, "VIDURA_PUBLIC_URL must use https in production")
		}
	}

	secret := get("VIDURA_SECRET", "")
	if len(secret) < 32 {
		problems = append(problems, "VIDURA_SECRET must be at least 32 characters (generate: openssl rand -hex 32)")
	}
	cfg.Secret = []byte(secret)

	for _, raw := range strings.Split(get("VIDURA_SUPERUSER_EMAILS", ""), ",") {
		email := NormalizeEmail(raw)
		if email == "" {
			continue
		}
		if _, err := mail.ParseAddress(email); err != nil {
			problems = append(problems, fmt.Sprintf("VIDURA_SUPERUSER_EMAILS has an invalid address: %q", raw))
			continue
		}
		cfg.SuperuserEmails[email] = true
	}
	if len(cfg.SuperuserEmails) == 0 {
		problems = append(problems, "VIDURA_SUPERUSER_EMAILS needs at least one address")
	}

	if (cfg.GoogleClientID == "") != (cfg.GoogleClientSecret == "") {
		problems = append(problems, "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together")
	}
	if cfg.DevLogin && cfg.Env != EnvDevelopment {
		problems = append(problems, "VIDURA_DEV_LOGIN is only allowed when VIDURA_ENV=development")
	}
	if cfg.Env == EnvProduction && !cfg.GoogleEnabled() {
		problems = append(problems, "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production")
	}
	if !cfg.GoogleEnabled() && !cfg.DevLogin {
		problems = append(problems, "no sign-in method: configure Google or enable VIDURA_DEV_LOGIN in development")
	}

	if len(problems) > 0 {
		return nil, errors.New("invalid configuration:\n  - " + strings.Join(problems, "\n  - "))
	}
	return cfg, nil
}
