#!/usr/bin/env bash
# Export the v1 (Postgres) data as JSON lines, one file per table, for
# `vidura import-legacy`.
#
#   scripts/export-legacy.sh [ssh-target] [out-dir]
#
# Runs on the VPS through SSH, as the database superuser inside the shared
# Postgres container, so no database password leaves the server. Every query
# runs in a read-only transaction. From better-auth only the user profile and
# the Google account id are exported: never tokens, passwords or sessions.
set -euo pipefail

TARGET="${1:-root@178.104.111.17}"
OUT="${2:-data/legacy}"
CONTAINER="${LEGACY_PG_CONTAINER:-platform-postgres}"
DATABASE="${LEGACY_PG_DATABASE:-vidura}"

mkdir -p "$OUT"
chmod 700 "$OUT"

export_table() {
  local name="$1" query="$2"
  printf 'SELECT row_to_json(t) FROM (%s) t;\n' "$query" |
    ssh -o BatchMode=yes "$TARGET" \
      "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on -c timezone=UTC' $CONTAINER psql -U postgres -d $DATABASE -At -v ON_ERROR_STOP=1 -q" \
      >"$OUT/$name.jsonl.part"
  mv "$OUT/$name.jsonl.part" "$OUT/$name.jsonl"
  chmod 600 "$OUT/$name.jsonl"
  printf '  %-22s %6s rows\n' "$name" "$(wc -l <"$OUT/$name.jsonl" | tr -d ' ')"
}

echo "Exporting $DATABASE from $TARGET into $OUT"
export_table users 'SELECT id, name, email, "emailVerified" AS email_verified, image, "createdAt" AS created_at, "updatedAt" AS updated_at FROM "user"'
export_table accounts 'SELECT "userId" AS user_id, "providerId" AS provider_id, "accountId" AS account_id FROM account'
export_table videos 'SELECT * FROM videos'
export_table transcript_segments 'SELECT * FROM transcript_segments'
export_table translated_segments 'SELECT * FROM translated_segments'
export_table processing_jobs 'SELECT * FROM processing_jobs'
export_table chat_threads 'SELECT * FROM chat_threads'
export_table chat_messages 'SELECT * FROM chat_messages'
export_table video_notes 'SELECT * FROM video_notes'
export_table user_chat_settings 'SELECT * FROM user_chat_settings'
export_table user_translation_settings 'SELECT * FROM user_translation_settings'
export_table push_subscriptions 'SELECT * FROM push_subscription'
echo "Done. Import with: vidura import-legacy --dir $OUT"
