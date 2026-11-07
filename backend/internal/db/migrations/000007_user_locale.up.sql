-- The language a user reads Vidura in ('en' or 'si'): the client portal's
-- interface, notifications, and the default for summaries and answers.
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'si'));
