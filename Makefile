# Vidura v2: Go backend (backend/) + admin portal (admin/) + client portal
# (client/), one binary.
#
#   make build         build both portals and embed them in backend/bin/vidura
#   make test          backend tests + both portals' lint/typecheck/build
#   make dev-backend   run the API on :8790 with local password sign-in
#   make dev-admin     run the admin portal with hot reload on :5174
#   make dev-client    run the client portal with hot reload on :5173
#   make import-prod   copy production data into the local database
#   make agent         build the Mac transcription agent

WEBUI_ADMIN  := backend/internal/webui/admin
WEBUI_CLIENT := backend/internal/webui/client
DEV_OWNER    ?= owner@example.com

.PHONY: build admin client agent test dev-backend dev-admin dev-client import-prod

# Each portal's build is copied over its embed folder. Old hashed assets from
# earlier local builds may linger there (they're gitignored); CI and Docker
# builds always start from an empty folder.
admin:
	cd admin && bun install --frozen-lockfile && bun run build
	cp -R admin/dist/. $(WEBUI_ADMIN)/

client:
	cd client && bun install --frozen-lockfile && bun run build
	cp -R client/dist/. $(WEBUI_CLIENT)/

build: admin client
	cd backend && go build -trimpath -ldflags "-s -w -X main.version=$$(git rev-parse --short HEAD)" -o bin/vidura ./cmd/vidura

# The transcription agent for the owner's Mac (backend/bin/vidura-agent).
agent:
	cd backend && go build -trimpath -ldflags "-s -w -X main.version=$$(git rev-parse --short HEAD)" -o bin/vidura-agent ./cmd/vidura-agent

test:
	cd backend && go vet ./... && go test -race ./...
	cd admin && bun run lint && bun run typecheck && bun run build
	cd client && bun run lint && bun run typecheck && bun run build

# Local development runs each part on its own address, like production:
#
#   client  http://vidura.prabhavalabs.localhost:5173        (make dev-client)
#   admin   http://admin-vidura.prabhavalabs.localhost:5174  (make dev-admin)
#   api     http://api-vidura.prabhavalabs.localhost:8790    (make dev-backend)
#
# *.localhost always resolves to this machine, and the three share the site
# prabhavalabs.localhost, so the API's SameSite=Lax cookie works across them.
# dev-backend reads backend/.env.local (ignored by Git) for the owner email,
# the local sign-in password and the secret.
DEV_API    ?= http://api-vidura.prabhavalabs.localhost:8790
DEV_ADMIN  ?= http://admin-vidura.prabhavalabs.localhost:5174
DEV_CLIENT ?= http://vidura.prabhavalabs.localhost:5173

DEV_ENV = cd backend && set -a && if test -e .env.local; then . ./.env.local; fi && set +a && \
	VIDURA_ENV=development \
	VIDURA_ADDR=127.0.0.1:8790 \
	VIDURA_DATA_DIR=./data \
	VIDURA_API_URL=$(DEV_API) \
	VIDURA_ADMIN_URL=$(DEV_ADMIN) \
	VIDURA_CLIENT_URL=$(DEV_CLIENT) \
	VIDURA_SECRET=$${VIDURA_SECRET:-development-only-secret-0000000000000000} \
	VIDURA_SUPERUSER_EMAILS=$${VIDURA_SUPERUSER_EMAILS:-$(DEV_OWNER)} \
	VIDURA_DEV_LOGIN=$${VIDURA_DEV_LOGIN:-true}

dev-backend:
	$(DEV_ENV) go run ./cmd/vidura serve

# Copy production data into the local database: a read-only export over SSH
# (scripts/export-legacy.sh), then an import that replaces local videos.
# Users are merged by email. The export stays in backend/data/legacy.
PROD_SSH ?= root@178.104.111.17

import-prod:
	cd backend && scripts/export-legacy.sh $(PROD_SSH) data/legacy
	$(DEV_ENV) go run ./cmd/vidura import-legacy --dir data/legacy --force

dev-admin:
	cd admin && VITE_API_URL=$(DEV_API) bun run dev

dev-client:
	cd client && VITE_API_URL=$(DEV_API) bun run dev
