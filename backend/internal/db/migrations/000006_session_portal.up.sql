-- Each session belongs to the portal that created it: the admin portal
-- (email and password) or the client portal (Google). A session is only
-- accepted from its own portal. Sessions before this were all admin ones.
ALTER TABLE sessions ADD COLUMN app TEXT NOT NULL DEFAULT 'admin' CHECK (app IN ('admin', 'client'));
