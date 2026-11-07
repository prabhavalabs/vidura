-- Optional password sign-in. Only an argon2id hash is stored, set with
-- `vidura set-password`; accounts without one sign in another way.
ALTER TABLE users ADD COLUMN password_hash TEXT;
