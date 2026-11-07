package config

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func env(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func validProduction() map[string]string {
	return map[string]string{
		"VIDURA_API_URL":          "https://api-vidura.example.com/",
		"VIDURA_ADMIN_URL":        "https://Admin-Vidura.example.com",
		"VIDURA_CLIENT_URL":       "https://vidura.example.com",
		"VIDURA_SECRET":           strings.Repeat("s", 32),
		"VIDURA_SUPERUSER_EMAILS": " Owner@Example.com , second@example.com",
		"GOOGLE_CLIENT_ID":        "client",
		"GOOGLE_CLIENT_SECRET":    "secret",
	}
}

func TestLoadProductionDefaults(t *testing.T) {
	cfg, err := load(env(validProduction()))
	require.NoError(t, err)

	assert.Equal(t, EnvProduction, cfg.Env)
	assert.Equal(t, ":8790", cfg.Addr)
	assert.Equal(t, "/data/vidura.db", cfg.DatabasePath())
	assert.Equal(t, "https://api-vidura.example.com", cfg.APIOrigin())
	assert.Equal(t, "https://admin-vidura.example.com", cfg.AdminOrigin())
	assert.Equal(t, "https://vidura.example.com", cfg.ClientOrigin())
	assert.Equal(t, AppAdmin, cfg.AppForOrigin("https://admin-vidura.example.com"))
	assert.Equal(t, AppClient, cfg.AppForOrigin("https://vidura.example.com"))
	assert.Equal(t, "", cfg.AppForOrigin("https://api-vidura.example.com"))
	assert.Equal(t, "", cfg.AppForOrigin("https://evil.example"))
	assert.True(t, cfg.SecureCookies())
	assert.True(t, cfg.GoogleEnabled())
	assert.True(t, cfg.IsSuperuserEmail("owner@example.com"))
	assert.True(t, cfg.IsSuperuserEmail(" OWNER@example.com "))
	assert.False(t, cfg.IsSuperuserEmail("someone@example.com"))
}

func TestLoadRejectsUnsafeProductionSettings(t *testing.T) {
	cases := map[string]func(map[string]string){
		"missing api url":     func(v map[string]string) { delete(v, "VIDURA_API_URL") },
		"missing admin url":   func(v map[string]string) { delete(v, "VIDURA_ADMIN_URL") },
		"missing client url":  func(v map[string]string) { delete(v, "VIDURA_CLIENT_URL") },
		"http in production":  func(v map[string]string) { v["VIDURA_ADMIN_URL"] = "http://admin-vidura.example.com" },
		"relative url":        func(v map[string]string) { v["VIDURA_API_URL"] = "/api" },
		"url with a path":     func(v map[string]string) { v["VIDURA_ADMIN_URL"] = "https://example.com/admin" },
		"shared host":         func(v map[string]string) { v["VIDURA_ADMIN_URL"] = "https://api-vidura.example.com" },
		"different site":      func(v map[string]string) { v["VIDURA_ADMIN_URL"] = "https://admin.other.example" },
		"short secret":        func(v map[string]string) { v["VIDURA_SECRET"] = "short" },
		"no superusers":       func(v map[string]string) { delete(v, "VIDURA_SUPERUSER_EMAILS") },
		"bad superuser":       func(v map[string]string) { v["VIDURA_SUPERUSER_EMAILS"] = "not-an-email" },
		"half google config":  func(v map[string]string) { delete(v, "GOOGLE_CLIENT_SECRET") },
		"no google in prod":   func(v map[string]string) { delete(v, "GOOGLE_CLIENT_ID"); delete(v, "GOOGLE_CLIENT_SECRET") },
		"dev login in prod":   func(v map[string]string) { v["VIDURA_DEV_LOGIN"] = "true" },
		"unknown environment": func(v map[string]string) { v["VIDURA_ENV"] = "staging" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			values := validProduction()
			mutate(values)
			_, err := load(env(values))
			assert.Error(t, err)
		})
	}
}

func TestLoadDevelopmentWithDevLogin(t *testing.T) {
	values := validProduction()
	values["VIDURA_ENV"] = EnvDevelopment
	values["VIDURA_API_URL"] = "http://api-vidura.prabhavalabs.localhost:8790"
	values["VIDURA_ADMIN_URL"] = "http://admin-vidura.prabhavalabs.localhost:5174"
	values["VIDURA_CLIENT_URL"] = "http://vidura.prabhavalabs.localhost:5173"
	values["VIDURA_DEV_LOGIN"] = "true"
	values["VIDURA_DEV_PASSWORD"] = "correct-horse-battery"
	delete(values, "GOOGLE_CLIENT_ID")
	delete(values, "GOOGLE_CLIENT_SECRET")

	cfg, err := load(env(values))
	require.NoError(t, err)
	assert.True(t, cfg.DevLogin)
	assert.False(t, cfg.SecureCookies())
	assert.Equal(t, "correct-horse-battery", cfg.DevPassword)
	assert.Equal(t, "http://admin-vidura.prabhavalabs.localhost:5174", cfg.AdminOrigin())
}

func TestLoadDevLoginNeedsAPassword(t *testing.T) {
	values := validProduction()
	values["VIDURA_ENV"] = EnvDevelopment
	values["VIDURA_DEV_LOGIN"] = "true"
	values["VIDURA_DEV_PASSWORD"] = "short"

	_, err := load(env(values))
	assert.ErrorContains(t, err, "VIDURA_DEV_PASSWORD")
}

func TestLoadIgnoresDevPasswordWithoutDevLogin(t *testing.T) {
	values := validProduction()
	values["VIDURA_DEV_PASSWORD"] = "correct-horse-battery"

	cfg, err := load(env(values))
	require.NoError(t, err)
	assert.Empty(t, cfg.DevPassword)
}

func TestLoadDevelopmentNeedsASignInMethod(t *testing.T) {
	values := validProduction()
	values["VIDURA_ENV"] = EnvDevelopment
	delete(values, "GOOGLE_CLIENT_ID")
	delete(values, "GOOGLE_CLIENT_SECRET")

	_, err := load(env(values))
	assert.ErrorContains(t, err, "no sign-in method")
}

func TestLoadProductionWithPasswordSignInOnly(t *testing.T) {
	values := validProduction()
	delete(values, "GOOGLE_CLIENT_ID")
	delete(values, "GOOGLE_CLIENT_SECRET")
	_, err := load(env(values))
	assert.ErrorContains(t, err, "no sign-in method")

	values["VIDURA_PASSWORD_LOGIN"] = "true"
	cfg, err := load(env(values))
	require.NoError(t, err)
	assert.True(t, cfg.PasswordLogin)
	assert.False(t, cfg.GoogleEnabled())
}
