package legacy

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

// fixture is a small v1 export: an owner and a family member, two videos
// (one ready from captions, one failed from Gemini), segments, one stale
// translation version, jobs and chat.
var fixture = map[string]string{
	"users": `{"id":"u-owner","name":"Owner","email":"Owner@Example.com","email_verified":true,"image":"https://img/o","created_at":"2026-07-05T17:12:39.553436+00:00","updated_at":"2026-07-05T17:12:39+00:00"}
{"id":"u-fam","name":"Family","email":"family@example.com","email_verified":true,"image":null,"created_at":"2026-07-06T10:00:00+00:00","updated_at":"2026-07-06T10:00:00+00:00"}`,
	"accounts": `{"user_id":"u-owner","provider_id":"google","account_id":"google-owner"}
{"user_id":"u-fam","provider_id":"google","account_id":"google-fam"}`,
	"videos": `{"id":"v1","owner_id":"u-fam","youtube_video_id":"abcdefghijk","youtube_url":"https://youtu.be/abcdefghijk","title":"Trees","channel_title":"Lab","thumbnail_url":null,"duration_ms":1550000,"source_language":"en","target_language":"si-LK","status":"ready","error_message":null,"metadata":{"transcript_source":"ytdlp","translation_model":"gpt-5.6-terra","subtitle_quality":{"score":95,"label":"excellent"},"youtube_metadata_fetched_at":"2026-09-01T05:35:45Z"},"created_at":"2026-09-01T05:35:45.650229+00:00","updated_at":"2026-09-01T05:41:17.724501+00:00"}
{"id":"v2","owner_id":"u-owner","youtube_video_id":"zyxwvutsrqp","youtube_url":"https://youtu.be/zyxwvutsrqp","title":"Brains","channel_title":null,"thumbnail_url":null,"duration_ms":null,"source_language":null,"target_language":"Sinhala","status":"translating","error_message":null,"metadata":{"transcript_source":"gemini"},"created_at":"2026-09-02T05:00:00+00:00","updated_at":"2026-09-02T05:00:00+00:00"}
{"id":"v3","owner_id":"u-ghost","youtube_video_id":"ghostghost1","youtube_url":"x","title":"Orphan","metadata":{},"status":"ready","target_language":"si-LK","created_at":"2026-09-02T05:00:00+00:00","updated_at":"2026-09-02T05:00:00+00:00"}`,
	"transcript_segments": `{"id":"s1","video_id":"v1","segment_index":0,"start_ms":0,"end_ms":1000,"source_language":"en","text":"Hello","normalized_text":"hello","created_at":"2026-09-01T05:36:00+00:00"}
{"id":"s2","video_id":"v1","segment_index":1,"start_ms":1000,"end_ms":2000,"source_language":"en","text":"World","normalized_text":"world","created_at":"2026-09-01T05:36:00+00:00"}
{"id":"s3","video_id":"v3","segment_index":0,"start_ms":0,"end_ms":1000,"source_language":"en","text":"Orphan","created_at":"2026-09-01T05:36:00+00:00"}`,
	"translated_segments": `{"id":"t1-old","segment_id":"s1","video_id":"v1","language_code":"si-LK","text":"old","model":"deepseek","version":1,"quality_flags":{},"created_at":"2026-09-01T05:40:00+00:00"}
{"id":"t1","segment_id":"s1","video_id":"v1","language_code":"si-LK","text":"ආයුබෝවන්","model":"gpt-5.6-terra","version":2,"quality_flags":{},"created_at":"2026-09-01T05:41:00+00:00"}
{"id":"t2","segment_id":"s2","video_id":"v1","language_code":"si-LK","text":"ලෝකය","model":"gpt-5.6-terra","version":1,"quality_flags":{},"created_at":"2026-09-01T05:41:00+00:00"}`,
	"processing_jobs": `{"id":"j1","owner_id":"u-fam","video_id":"v1","kind":"process_video","status":"ready","progress":100,"attempts":0,"error_message":null,"metadata":{"stage":"ready","translator":"gpt-5.6-terra","total_segments":2,"translation_context":{"topic":"Trees","glossary":[]},"current_segment_text":"x"},"started_at":"2026-09-01T05:35:46+00:00","finished_at":"2026-09-01T05:41:17+00:00","created_at":"2026-09-01T05:35:45+00:00","updated_at":"2026-09-01T05:41:17+00:00"}
{"id":"j2","owner_id":"u-owner","video_id":"v2","kind":"process_video","status":"failed","progress":40,"attempts":2,"error_message":null,"metadata":{"stage":"failed","error":"OpenAI failed with 401: Incorrect API key provided: sk-svcac********blYA."},"started_at":"2026-09-02T05:00:01+00:00","finished_at":"2026-09-02T05:01:00+00:00","created_at":"2026-09-02T05:00:00+00:00","updated_at":"2026-09-02T05:01:00+00:00"}
{"id":"j3","owner_id":"u-owner","video_id":"v2","kind":"embed_segments","status":"ready","progress":100,"attempts":0,"metadata":{},"created_at":"2026-09-02T05:00:00+00:00","updated_at":"2026-09-02T05:00:00+00:00"}`,
	"chat_threads":              `{"id":"c1","owner_id":"u-owner","video_id":"v1","title":"About trees","created_at":"2026-09-03T00:00:00+00:00","updated_at":"2026-09-03T00:00:00+00:00"}`,
	"chat_messages":             `{"id":"m1","thread_id":"c1","owner_id":"u-owner","role":"user","content":"Why?","cited_segment_ids":["s1"],"metadata":{},"created_at":"2026-09-03T00:00:01+00:00"}`,
	"video_notes":               ``,
	"user_chat_settings":        `{"owner_id":"u-owner","response_language":"si","answer_style":"balanced","custom_instructions":"","memory_depth":"medium","retrieval_depth":"standard","creativity":"balanced","created_at":"2026-07-07T04:06:12+00:00","updated_at":"2026-07-07T04:06:12+00:00"}`,
	"user_translation_settings": `{"owner_id":"u-fam","target_language":"Sinhala","system_prompt":"Be kind","created_at":"2026-07-07T04:06:12+00:00","updated_at":"2026-07-07T04:06:12+00:00"}`,
	"push_subscriptions":        `{"id":"p1","owner_id":"u-owner","endpoint":"https://push.example/1","p256dh":"key","auth":"secret","created_at":"2026-07-08T14:17:52+00:00"}`,
}

func setup(t *testing.T) (*sql.DB, *config.Config, string) {
	t.Helper()
	dir := t.TempDir()
	for name, content := range fixture {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name+".jsonl"), []byte(content+"\n"), 0o600))
	}
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })
	cfg := &config.Config{SuperuserEmails: map[string]bool{"owner@example.com": true}}
	return database, cfg, dir
}

func one[T any](t *testing.T, database *sql.DB, query string, args ...any) T {
	t.Helper()
	var value T
	require.NoError(t, database.QueryRow(query, args...).Scan(&value), query)
	return value
}

func TestImportCopiesEverythingAndReports(t *testing.T) {
	database, cfg, dir := setup(t)
	report, err := Import(context.Background(), database, cfg, dir, Options{})
	require.NoError(t, err)

	byTable := map[string]TableReport{}
	for _, table := range report {
		byTable[table.Table] = table
	}
	assert.Equal(t, TableReport{Table: "users", Source: 2, Imported: 2}, byTable["users"])
	assert.Equal(t, TableReport{Table: "videos", Source: 3, Imported: 2, Skipped: 1}, byTable["videos"], "orphan video skipped")
	assert.Equal(t, TableReport{Table: "transcript_segments", Source: 3, Imported: 2, Skipped: 1}, byTable["transcript_segments"])
	assert.Equal(t, TableReport{Table: "translated_segments", Source: 3, Imported: 2, Skipped: 1}, byTable["translated_segments"])
	assert.Equal(t, TableReport{Table: "jobs", Source: 3, Imported: 2, Skipped: 1}, byTable["jobs"], "embedding jobs dropped")

	// Users: owner is a superuser, the family member a member with an invite.
	assert.Equal(t, "superuser", one[string](t, database, `SELECT role FROM users WHERE email = 'owner@example.com'`))
	assert.Equal(t, "member", one[string](t, database, `SELECT role FROM users WHERE email = 'family@example.com'`))
	assert.Equal(t, "google-fam", one[string](t, database, `SELECT google_sub FROM users WHERE email = 'family@example.com'`))
	assert.Equal(t, 1, one[int](t, database, `SELECT count(*) FROM allowed_emails`))

	// Videos: language codes normalized, source mapped, context moved over.
	assert.Equal(t, "si", one[string](t, database, `SELECT target_language FROM videos WHERE id = 'v1'`))
	assert.Equal(t, "captions", one[string](t, database, `SELECT transcript_source FROM videos WHERE id = 'v1'`))
	assert.Equal(t, "Trees", one[string](t, database, `SELECT json_extract(translation_context, '$.topic') FROM videos WHERE id = 'v1'`))
	assert.Equal(t, 95, one[int](t, database, `SELECT json_extract(subtitle_quality, '$.score') FROM videos WHERE id = 'v1'`))
	assert.Equal(t, "2026-09-01T05:35:45.650Z", one[string](t, database, `SELECT created_at FROM videos WHERE id = 'v1'`))
	assert.Equal(t, "asr", one[string](t, database, `SELECT transcript_source FROM videos WHERE id = 'v2'`))
	assert.Equal(t, "failed", one[string](t, database, `SELECT status FROM videos WHERE id = 'v2'`), "in-flight v1 work is marked failed")

	// The newest translation version wins.
	assert.Equal(t, "ආයුබෝවන්", one[string](t, database, `SELECT text FROM translated_segments WHERE segment_id = 's1'`))

	// Jobs: statuses mapped, API keys scrubbed from errors.
	assert.Equal(t, "succeeded", one[string](t, database, `SELECT status FROM jobs WHERE id = 'j1'`))
	message := one[string](t, database, `SELECT error_message FROM jobs WHERE id = 'j2'`)
	assert.NotContains(t, message, "sk-svcac")
	assert.Contains(t, message, "[redacted]")
	assert.False(t, strings.Contains(one[string](t, database, `SELECT details FROM jobs WHERE id = 'j1'`), "translation_context"))

	assert.Equal(t, `["s1"]`, one[string](t, database, `SELECT cited_segment_ids FROM chat_messages WHERE id = 'm1'`))
	assert.Equal(t, "si", one[string](t, database, `SELECT target_language FROM translation_settings`))
}

func TestImportMergesExistingUserByEmail(t *testing.T) {
	database, cfg, dir := setup(t)
	_, err := database.Exec(`INSERT INTO users (id, email, role) VALUES ('local-owner', 'owner@example.com', 'superuser')`)
	require.NoError(t, err)

	_, err = Import(context.Background(), database, cfg, dir, Options{})
	require.NoError(t, err)
	assert.Equal(t, 2, one[int](t, database, `SELECT count(*) FROM users`))
	assert.Equal(t, "local-owner", one[string](t, database, `SELECT owner_id FROM videos WHERE id = 'v2'`))
	assert.Equal(t, "google-owner", one[string](t, database, `SELECT google_sub FROM users WHERE id = 'local-owner'`))
	assert.Equal(t, "Owner", one[string](t, database, `SELECT name FROM users WHERE id = 'local-owner'`))
}

func TestImportRefusesToOverwriteUnlessForced(t *testing.T) {
	database, cfg, dir := setup(t)
	_, err := Import(context.Background(), database, cfg, dir, Options{})
	require.NoError(t, err)

	_, err = Import(context.Background(), database, cfg, dir, Options{})
	assert.ErrorIs(t, err, ErrNotEmpty)

	_, err = Import(context.Background(), database, cfg, dir, Options{Force: true})
	require.NoError(t, err)
	assert.Equal(t, 2, one[int](t, database, `SELECT count(*) FROM videos`))
	assert.Equal(t, 2, one[int](t, database, `SELECT count(*) FROM jobs`))
}

func TestImportFailsWholeOnBadInput(t *testing.T) {
	database, cfg, dir := setup(t)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "chat_messages.jsonl"), []byte("{not json\n"), 0o600))
	_, err := Import(context.Background(), database, cfg, dir, Options{})
	require.Error(t, err)
	assert.Equal(t, 0, one[int](t, database, `SELECT count(*) FROM videos`), "nothing is written")
}
