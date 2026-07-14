-- PLNR-87: forgot-password / email reset links. A short-lived, single-use token
-- (hashed at rest, like invites) mapped to a user.
CREATE TABLE password_resets (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,   -- SHA-256 of the reset token
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);
