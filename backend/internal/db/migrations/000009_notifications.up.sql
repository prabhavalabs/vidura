-- What Vidura told each person. Every notification push.Service.Send makes
-- is kept here, so the app can show an unread count (the bell and the app
-- icon badge) and a list, whether or not a push reached a device.
CREATE TABLE notifications (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- video_ready, video_failed, chat_answer, notes_ready, ... (free text;
    -- the app picks an icon from it).
    kind       TEXT NOT NULL DEFAULT '',
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    -- The client portal path the notification opens.
    url        TEXT NOT NULL DEFAULT '/',
    -- A newer notification with the same tag replaces the older one.
    tag        TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    read_at    TEXT
);
CREATE INDEX notifications_owner_idx ON notifications (owner_id, created_at);
CREATE INDEX notifications_unread_idx ON notifications (owner_id) WHERE read_at IS NULL;
