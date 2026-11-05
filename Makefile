# Vidura v2: Go backend (backend/) + admin portal (admin/), one binary.
#
#   make build         build the admin portal and embed it in backend/bin/vidura
#   make test          backend tests + admin lint/typecheck/build
#   make dev-backend   run the API on :8790 with development sign-in
#   make dev-admin     run the admin portal with hot reload on :5174

WEBUI_ADMIN := backend/internal/webui/admin
DEV_OWNER   ?= owner@example.com

.PHONY: build admin test dev-backend dev-admin

# The portal build is copied over the embed folder. Old hashed assets from
# earlier local builds may linger there (they're gitignored); CI and Docker
# builds always start from an empty folder.
admin:
	cd admin && bun install --frozen-lockfile && bun run build
	cp -R admin/dist/. $(WEBUI_ADMIN)/

build: admin
	cd backend && go build -trimpath -ldflags "-s -w -X main.version=$$(git rev-parse --short HEAD)" -o bin/vidura ./cmd/vidura

test:
	cd backend && go vet ./... && go test -race ./...
	cd admin && bun run lint && bun run typecheck && bun run build

# Development: the admin portal on :5174 proxies API calls to this server, so
# the public URL (and therefore the allowed Origin) is the Vite address.
dev-backend:
	cd backend && \
	VIDURA_ENV=development \
	VIDURA_ADDR=127.0.0.1:8790 \
	VIDURA_DATA_DIR=./data \
	VIDURA_PUBLIC_URL=$${VIDURA_PUBLIC_URL:-http://localhost:5174} \
	VIDURA_SECRET=$${VIDURA_SECRET:-development-only-secret-0000000000000000} \
	VIDURA_SUPERUSER_EMAILS=$${VIDURA_SUPERUSER_EMAILS:-$(DEV_OWNER)} \
	VIDURA_DEV_LOGIN=$${VIDURA_DEV_LOGIN:-true} \
	go run ./cmd/vidura serve

dev-admin:
	cd admin && bun run dev
