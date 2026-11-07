// Command vidura runs the Vidura server.
//
//	vidura serve     start the HTTP server (applies migrations first)
//	vidura migrate   apply database migrations and exit
//	vidura import-legacy --dir DIR [--force]
//	                 import a v1 export (scripts/export-legacy.sh)
//	vidura version   print the build version
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"github.com/prabhavalabs/vidura/backend/internal/accounts"
	"github.com/prabhavalabs/vidura/backend/internal/agenthub"
	"github.com/prabhavalabs/vidura/backend/internal/audit"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/db"
	"github.com/prabhavalabs/vidura/backend/internal/httpapi"
	"github.com/prabhavalabs/vidura/backend/internal/learn"
	"github.com/prabhavalabs/vidura/backend/internal/legacy"
	"github.com/prabhavalabs/vidura/backend/internal/pipeline"
	"github.com/prabhavalabs/vidura/backend/internal/push"
	"github.com/prabhavalabs/vidura/backend/internal/settings"
	"github.com/prabhavalabs/vidura/backend/internal/webui"
	"github.com/prabhavalabs/vidura/backend/internal/worker"
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
	case "import-legacy":
		err = importLegacy(os.Args[2:])
	case "pairing-code":
		err = pairingCode()
	case "set-password":
		err = setPassword(os.Args[2:])
	case "version":
		fmt.Println(version)
	default:
		err = fmt.Errorf("unknown command %q (want serve, migrate, import-legacy, pairing-code, set-password or version)", command)
	}
	if err != nil {
		slog.Error("vidura exited", "error", err)
		os.Exit(1)
	}
}

// setPassword gives an account a password for email sign-in. The password is
// read from stdin (typed without echo on a terminal, or piped), never from
// the command line, so it stays out of shell history and the process list.
func setPassword(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: vidura set-password <email>   (the password is read from stdin)")
	}
	var password string
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprint(os.Stderr, "New password: ")
		raw, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return err
		}
		password = string(raw)
	} else {
		line, err := bufio.NewReader(io.LimitReader(os.Stdin, 4096)).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		password = strings.TrimRight(line, "\r\n")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	database, err := db.OpenAndMigrate(cfg.DatabasePath())
	if err != nil {
		return err
	}
	defer database.Close()
	user, err := accounts.NewStore(database, cfg).SetPassword(context.Background(), args[0], password)
	if err != nil {
		return err
	}
	audit.New(database).Record(context.Background(), audit.Entry{
		ActorID: user.ID, ActorEmail: user.Email, Action: audit.PasswordSet, Target: user.ID, IP: "cli",
	})
	fmt.Printf("Password set for %s (%s). Their other sessions were signed out.\n", user.Email, user.Role)
	return nil
}

// pairingCode prints a single-use code for pairing a Mac agent, like the
// admin portal's "Pair a Mac" button. It needs shell access to the server,
// and is recorded in the audit log under the first owner account.
func pairingCode() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	database, err := db.OpenAndMigrate(cfg.DatabasePath())
	if err != nil {
		return err
	}
	defer database.Close()
	emails := make([]string, 0, len(cfg.SuperuserEmails))
	for email := range cfg.SuperuserEmails {
		emails = append(emails, email)
	}
	sort.Strings(emails)
	var owner accounts.User
	for _, email := range emails {
		if err := database.QueryRow(`SELECT id, email FROM users WHERE email = ?`, email).Scan(&owner.ID, &owner.Email); err == nil {
			break
		}
	}
	if owner.ID == "" {
		return errors.New("no owner account exists yet; sign in to the admin portal once first")
	}
	code, err := agenthub.New(database, audit.New(database), false).CreatePairingCode(context.Background(), owner, "cli")
	if err != nil {
		return err
	}
	fmt.Printf("Pairing code: %s (valid until %s)\n", code.Code, code.ExpiresAt.Local().Format("15:04"))
	fmt.Printf("On the Mac: vidura-agent pair --server %s --code %s\n", cfg.APIOrigin(), code.Code)
	return nil
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

func importLegacy(args []string) error {
	flags := flag.NewFlagSet("import-legacy", flag.ContinueOnError)
	dir := flags.String("dir", "data/legacy", "directory holding the *.jsonl export")
	force := flags.Bool("force", false, "replace existing videos and content")
	if err := flags.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	database, err := db.OpenAndMigrate(cfg.DatabasePath())
	if err != nil {
		return err
	}
	defer database.Close()

	report, err := legacy.Import(context.Background(), database, cfg, *dir, legacy.Options{Force: *force})
	if err != nil {
		return err
	}
	fmt.Printf("Imported %s into %s\n\n", *dir, cfg.DatabasePath())
	fmt.Printf("  %-22s %8s %9s %8s\n", "table", "source", "imported", "skipped")
	for _, table := range report {
		fmt.Printf("  %-22s %8d %9d %8d\n", table.Table, table.Source, table.Imported, table.Skipped)
	}
	return nil
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
			cfg.APIOrigin()+"/auth/google/callback")
	}
	authService := auth.NewService(cfg, store, auditLog, provider)
	ai, err := chatgpt.New(filepath.Join(cfg.DataDir, "codex"), httpapi.AILoginRecorder(auditLog))
	if err != nil {
		return err
	}
	hub := agenthub.New(database, auditLog, cfg.TrustProxy)
	notifier := push.New(database, cfg.ClientOrigin())
	tutor := learn.New(database, ai, settings.NewStore(database), filepath.Join(cfg.DataDir, "images"))
	tutor.Recover(context.Background())
	tutor.SetNotifier(notifier)
	jobs := worker.New(database, settings.NewStore(database), worker.Options{
		Model:       ai,
		Captions:    pipeline.YouTube{Proxy: cfg.YouTubeProxy},
		Transcriber: hub,
		Finished:    notifier.VideoFinished,
	})

	server := &http.Server{
		Addr: cfg.Addr,
		Handler: httpapi.New(httpapi.Deps{
			Config:    cfg,
			DB:        database,
			Accounts:  store,
			Audit:     auditLog,
			Auth:      authService,
			AdminUI:   webui.Admin(),
			ClientUI:  webui.Client(),
			Version:   version,
			ChatGPT:   ai,
			Hub:       hub,
			JobQueued: jobs.Notify,
			Push:      notifier,
			Learn:     tutor,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go purgeSessions(ctx, store)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		jobs.Run(ctx)
	}()

	errs := make(chan error, 1)
	go func() {
		slog.Info("vidura listening", "addr", cfg.Addr, "env", cfg.Env, "version", version,
			"api", cfg.APIOrigin(), "admin", cfg.AdminOrigin(), "client", cfg.ClientOrigin(),
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
	hub.Close()
	ai.CancelLogin()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	err = server.Shutdown(shutdownCtx)
	// Running jobs stop with ctx and are requeued on the next start.
	select {
	case <-workerDone:
	case <-shutdownCtx.Done():
	}
	return err
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
