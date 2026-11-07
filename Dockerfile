# Vidura v2: one image with the Go server, the embedded portals, the
# Codex CLI (ChatGPT subscription) and yt-dlp (YouTube captions).
#
#   docker build -t vidura:dev .
#
# The container keeps everything it writes in /data (SQLite database and the
# Codex CLI's sign-in), which must be a volume.

ARG GO_VERSION=1.26
ARG BUN_VERSION=1.3.0
ARG ALPINE_VERSION=3.22
ARG CODEX_CLI_VERSION=0.166.0

FROM oven/bun:${BUN_VERSION}-alpine AS admin
WORKDIR /src/admin
COPY admin/package.json admin/bun.lock ./
RUN bun install --frozen-lockfile
COPY admin/ ./
RUN bun run build

FROM oven/bun:${BUN_VERSION}-alpine AS client
WORKDIR /src/client
COPY client/package.json client/bun.lock ./
RUN bun install --frozen-lockfile
COPY client/ ./
RUN bun run build

FROM golang:${GO_VERSION}-alpine AS server
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
COPY --from=admin /src/admin/dist/ ./internal/webui/admin/
COPY --from=client /src/client/dist/ ./internal/webui/client/
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/vidura ./cmd/vidura

FROM alpine:${ALPINE_VERSION}
ARG CODEX_CLI_VERSION
RUN apk add --no-cache ca-certificates tzdata nodejs npm python3 py3-pip \
    && npm install --global --omit=dev "@openai/codex@${CODEX_CLI_VERSION}" \
    && npm cache clean --force \
    && pip install --break-system-packages --no-cache-dir -U "yt-dlp[default]" \
    && addgroup -S -g 10001 vidura \
    && adduser -S -D -u 10001 -G vidura -h /home/vidura vidura \
    && mkdir -p /data \
    && chown vidura:vidura /data
COPY --from=server /out/vidura /usr/local/bin/vidura

USER vidura
ENV VIDURA_ENV=production \
    VIDURA_ADDR=:8080 \
    VIDURA_DATA_DIR=/data \
    HOME=/home/vidura
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["vidura"]
CMD ["serve"]
