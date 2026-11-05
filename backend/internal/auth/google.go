package auth

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
)

// Provider is an OpenID Connect identity provider.
type Provider interface {
	// AuthURL is where the browser is sent to sign in.
	AuthURL(state, nonce, codeVerifier string) (string, error)
	// Exchange trades the callback code for a verified identity, checking the
	// ID token's signature, issuer, audience, expiry and nonce.
	Exchange(ctx context.Context, code, codeVerifier, nonce string) (accounts.Identity, error)
}

const googleIssuer = "https://accounts.google.com"

// Google signs people in with their Google account. OIDC discovery runs on
// first use and is retried on failure, so a network blip at start-up doesn't
// leave the server unable to sign anyone in.
type Google struct {
	clientID     string
	clientSecret string
	redirectURL  string

	mu       sync.Mutex
	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

// NewGoogle returns a Google provider.
func NewGoogle(clientID, clientSecret, redirectURL string) *Google {
	return &Google{clientID: clientID, clientSecret: clientSecret, redirectURL: redirectURL}
}

func (g *Google) init(ctx context.Context) (*oauth2.Config, *oidc.IDTokenVerifier, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.oauth != nil {
		return g.oauth, g.verifier, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	provider, err := oidc.NewProvider(ctx, googleIssuer)
	if err != nil {
		return nil, nil, fmt.Errorf("google discovery: %w", err)
	}
	g.oauth = &oauth2.Config{
		ClientID:     g.clientID,
		ClientSecret: g.clientSecret,
		RedirectURL:  g.redirectURL,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
	}
	g.verifier = provider.Verifier(&oidc.Config{ClientID: g.clientID})
	return g.oauth, g.verifier, nil
}

// AuthURL implements Provider.
func (g *Google) AuthURL(state, nonce, codeVerifier string) (string, error) {
	config, _, err := g.init(context.Background())
	if err != nil {
		return "", err
	}
	return config.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.S256ChallengeOption(codeVerifier),
		oauth2.SetAuthURLParam("prompt", "select_account"),
	), nil
}

// Exchange implements Provider.
func (g *Google) Exchange(ctx context.Context, code, codeVerifier, nonce string) (accounts.Identity, error) {
	config, verifier, err := g.init(ctx)
	if err != nil {
		return accounts.Identity{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, err := config.Exchange(ctx, code, oauth2.VerifierOption(codeVerifier))
	if err != nil {
		return accounts.Identity{}, fmt.Errorf("exchange code: %w", err)
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return accounts.Identity{}, errors.New("token response has no id_token")
	}
	idToken, err := verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return accounts.Identity{}, fmt.Errorf("verify id token: %w", err)
	}
	if idToken.Nonce != nonce {
		return accounts.Identity{}, errors.New("id token nonce mismatch")
	}
	var claims struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return accounts.Identity{}, fmt.Errorf("read id token claims: %w", err)
	}
	return accounts.Identity{
		Subject:       idToken.Subject,
		Email:         claims.Email,
		EmailVerified: claims.EmailVerified,
		Name:          claims.Name,
		Picture:       claims.Picture,
	}, nil
}
