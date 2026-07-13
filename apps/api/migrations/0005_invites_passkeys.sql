-- User invites (email or copyable link), passkeys (WebAuthn), user↔group
-- membership, and short-lived WebAuthn challenges.

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,   -- SHA-256 of the invite token
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_invites_user ON invites (user_id);

CREATE TABLE passkeys (
  id         TEXT PRIMARY KEY,        -- credential id (base64url)
  user_id    TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,           -- base64url COSE public key
  counter    INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name       TEXT NOT NULL DEFAULT 'passkey',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_passkeys_user ON passkeys (user_id);

-- User membership in groups (informational for now; ACL enforcement is a later phase).
CREATE TABLE user_groups (
  user_id  TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE webauthn_challenges (
  challenge  TEXT PRIMARY KEY,        -- base64url challenge
  user_id    TEXT,                    -- set for registration; null for discoverable login
  kind       TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  expires_at TEXT NOT NULL
);
