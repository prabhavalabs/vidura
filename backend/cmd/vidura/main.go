// Command vidura runs the Vidura server.
//
//	vidura serve     start the HTTP server (applies migrations first)
//	vidura migrate   apply database migrations and exit
//	vidura version   print the build version
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/httpapi"
	"github.com/prabhavalabs/vidura/backend/internal/webui"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "dev"

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	var err error
	switch command {
	case "serve":
		err = serve()
	case "migrate":
		err = migrateOnly()
	case "version":
		fmt.Println(version)
	default:
		err = fmt.Errorf("unknown command %q (want serve, migrate or version)", command)
	}
	if err != nil {
		slog.Error("vidura exited", "error", err)
		os.Exit(1)
	}
}

func migrateOnly() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	database, err := db.OpenAndMigrate(cfg.DatabasePath())
	if err != nil {
		return err
	}
	slog.Info("migrations applied", "database", cfg.DatabasePath())
	return database.Close()
}

func serve() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	database, err := db.OpenAndMigrate(cfg.DatabasePath())
	if err != nil {
		return err
	}
	defer database.Close()

	store := accounts.NewStore(database, cfg)
	auditLog := audit.New(database)
	var provider auth.Provider
	if cfg.GoogleEnabled() {
		provider = auth.NewGoogle(cfg.GoogleClientID, cfg.GoogleClientSecret,
			cfg.PublicURL.String()+"/auth/google/callback")
	}
	authService := auth.NewService(cfg, store, auditLog, provider)

	server := &http.Server{
		Addr: cfg.Addr,
		Handler: httpapi.New(httpapi.Deps{
			Config:   cfg,
			DB:       database,
			Accounts: store,
			Audit:    auditLog,
			Auth:     authService,
			AdminUI:  webui.Admin(),
			Version:  version,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go purgeSessions(ctx, store)

	errs := make(chan error, 1)
	go func() {
		slog.Info("vidura listening", "addr", cfg.Addr, "env", cfg.Env, "version", version,
			"google", cfg.GoogleEnabled(), "devLogin", cfg.DevLogin)
		errs <- server.ListenAndServe()
	}()

	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

func purgeSessions(ctx context.Context, store *accounts.Store) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if removed, err := store.PurgeExpiredSessions(ctx); err != nil {
			slog.Error("purge sessions", "error", err)
		} else if removed > 0 {
			slog.Info("purged expired sessions", "count", removed)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
