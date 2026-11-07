-- Transcription agents (the owner's Mac) and admin-tunable settings.

-- A paired agent. Only the SHA-256 of its device token is stored; revoking
-- sets revoked_at and the token stops working at once.
CREATE TABLE devices (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    hostname      TEXT NOT NULL DEFAULT '',
    platform      TEXT NOT NULL DEFAULT '',
    agent_version TEXT NOT NULL DEFAULT '',
    -- Engines and tools the agent last reported (json).
    capabilities  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities)),
    paired_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT,
    last_ip       TEXT NOT NULL DEFAULT '',
    revoked_at    TEXT
);

-- Single-use pairing codes, stored hashed, valid for ten minutes.
CREATE TABLE pairing_codes (
    code_hash  TEXT PRIMARY KEY,
    created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    device_id  TEXT REFERENCES devices (id) ON DELETE SET NULL
);

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL CHECK (json_valid(value)),
    updated_by TEXT REFERENCES users (id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
);
