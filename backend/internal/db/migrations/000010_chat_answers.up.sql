-- Tutor answers are written while the model streams them. An answer is
-- 'streaming' until it ends 'done', 'failed' (error_message holds a short
-- code the app explains; the answer can be retried) or 'stopped' (the
-- learner stopped it). Questions are always 'done'.
ALTER TABLE chat_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'done'
    CHECK (status IN ('streaming', 'done', 'failed', 'stopped'));
ALTER TABLE chat_messages ADD COLUMN error_message TEXT;
CREATE INDEX chat_messages_streaming_idx ON chat_messages (thread_id) WHERE status = 'streaming';
