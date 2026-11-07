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

	"golang.org/x/net/publicsuffix"
)

// Environment names.
const (
	EnvProduction  = "production"
	EnvDevelopment = "development"
)

// Config is the validated runtime configuration.
type Config struct {
	Env     string
	Addr    string
	DataDir string

	// The three public addresses. Each is scheme://host[:port] with no path,
	// and each has its own host. The API serves /api and /auth; the admin and
	// client portals call it cross-origin with credentials, so all three must
	// share a registrable domain (the session cookie is SameSite=Lax).
	APIURL    *url.URL
	AdminURL  *url.URL
	ClientURL *url.URL
	// Secret signs short-lived OAuth state cookies. At least 32 bytes.
	Secret []byte

	GoogleClientID     string
	GoogleClientSecret string

	// SuperuserEmails are always superusers. They can't be demoted, disabled
	// or deleted from the admin portal, so the owner can't be locked out.
	SuperuserEmails map[string]bool

	// DevLogin lets an allowed email sign in with DevPassword (from the
	// environment) at POST /auth/password. Only permitted when Env is
	// development, and only with a password of at least 8 characters.
	DevLogin    bool
	DevPassword string

	// PasswordLogin enables email and password sign-in at POST
	// /auth/password for accounts given a password with `vidura
	// set-password` (stored as an argon2id hash).
	PasswordLogin bool

	// TrustProxy makes the server read the client address from the
	// X-Forwarded-For header set by the reverse proxy in front of it.
	TrustProxy bool
	// YouTubeProxy is passed to yt-dlp; YouTube blocks most datacenter IPs.
	YouTubeProxy string
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
func (c *Config) SecureCookies() bool { return c.APIURL.Scheme == "https" }

// APIOrigin, AdminOrigin and ClientOrigin are the scheme://host[:port] of
// each public address, as browsers send them in the Origin header.
func (c *Config) APIOrigin() string    { return origin(c.APIURL) }
func (c *Config) AdminOrigin() string  { return origin(c.AdminURL) }
func (c *Config) ClientOrigin() string { return origin(c.ClientURL) }

// AppOrigin returns the origin of the named app ("admin" or "client").
func (c *Config) AppOrigin(app string) string {
	if app == AppAdmin {
		return c.AdminOrigin()
	}
	return c.ClientOrigin()
}

// AppForOrigin maps a browser Origin header to the app it belongs to, or ""
// when it is neither portal.
func (c *Config) AppForOrigin(o string) string {
	switch o {
	case c.AdminOrigin():
		return AppAdmin
	case c.ClientOrigin():
		return AppClient
	}
	return ""
}

// App names.
const (
	AppAdmin  = "admin"
	AppClient = "client"
)

func origin(u *url.URL) string { return u.Scheme + "://" + u.Host }

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
		PasswordLogin:      get("VIDURA_PASSWORD_LOGIN", "false") == "true",
		TrustProxy:         get("VIDURA_TRUST_PROXY", "false") == "true",
		YouTubeProxy:       get("VIDURA_YOUTUBE_PROXY", ""),
		SuperuserEmails:    map[string]bool{},
	}

	if cfg.Env != EnvProduction && cfg.Env != EnvDevelopment {
		problems = append(problems, fmt.Sprintf("VIDURA_ENV must be %q or %q", EnvProduction, EnvDevelopment))
	}

	parseURL := func(name, example string) *url.URL {
		raw := get(name, "")
		if raw == "" {
			problems = append(problems, fmt.Sprintf("%s is required (e.g. %s)", name, example))
			return nil
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") ||
			strings.Trim(parsed.Path, "/") != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
			problems = append(problems, fmt.Sprintf("%s must be an absolute http(s) address with no path (e.g. %s)", name, example))
			return nil
		}
		if parsed.Scheme == "http" && cfg.Env == EnvProduction {
			problems = append(problems, fmt.Sprintf("%s must use https in production", name))
		}
		return &url.URL{Scheme: parsed.Scheme, Host: strings.ToLower(parsed.Host)}
	}
	cfg.APIURL = parseURL("VIDURA_API_URL", "https://api-vidura.prabhavalabs.com")
	cfg.AdminURL = parseURL("VIDURA_ADMIN_URL", "https://admin-vidura.prabhavalabs.com")
	cfg.ClientURL = parseURL("VIDURA_CLIENT_URL", "https://vidura.prabhavalabs.com")
	if cfg.APIURL != nil && cfg.AdminURL != nil && cfg.ClientURL != nil {
		problems = append(problems, checkSites(cfg.APIURL, cfg.AdminURL, cfg.ClientURL)...)
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
	cfg.DevPassword = getenv("VIDURA_DEV_PASSWORD")
	if cfg.DevLogin && len(cfg.DevPassword) < 8 {
		problems = append(problems, "VIDURA_DEV_LOGIN needs VIDURA_DEV_PASSWORD of at least 8 characters")
	}
	if !cfg.DevLogin {
		cfg.DevPassword = ""
	}
	if !cfg.GoogleEnabled() && !cfg.PasswordLogin && !cfg.DevLogin {
		problems = append(problems, "no sign-in method: configure Google, set VIDURA_PASSWORD_LOGIN=true, or enable VIDURA_DEV_LOGIN in development")
	}

	if len(problems) > 0 {
		return nil, errors.New("invalid configuration:\n  - " + strings.Join(problems, "\n  - "))
	}
	return cfg, nil
}

// checkSites makes sure the three addresses have distinct hosts, one scheme,
// and one registrable domain, so the API's SameSite=Lax session cookie is
// sent on the portals' cross-origin requests.
func checkSites(api, admin, client *url.URL) []string {
	var problems []string
	if api.Host == admin.Host || api.Host == client.Host || admin.Host == client.Host {
		problems = append(problems, "VIDURA_API_URL, VIDURA_ADMIN_URL and VIDURA_CLIENT_URL must each have their own host")
	}
	if api.Scheme != admin.Scheme || api.Scheme != client.Scheme {
		problems = append(problems, "VIDURA_API_URL, VIDURA_ADMIN_URL and VIDURA_CLIENT_URL must use the same scheme")
	}
	site := func(u *url.URL) string {
		domain, err := publicsuffix.EffectiveTLDPlusOne(u.Hostname())
		if err != nil {
			return u.Hostname()
		}
		return domain
	}
	if site(api) != site(admin) || site(api) != site(client) {
		problems = append(problems, fmt.Sprintf(
			"VIDURA_API_URL, VIDURA_ADMIN_URL and VIDURA_CLIENT_URL must share one registrable domain (got %s, %s, %s)",
			site(api), site(admin), site(client)))
	}
	return problems
}
