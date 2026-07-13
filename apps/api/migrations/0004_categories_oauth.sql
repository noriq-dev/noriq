-- Task categories (custom, per project) + OAuth 2.1 authorization server tables
-- (MCP clients authenticate via authorization-code + PKCE; tokens map to agents).

CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#8a95a3',
  "order"    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, name)
);
CREATE INDEX idx_categories_project ON categories (project_id);

ALTER TABLE tasks ADD COLUMN category_id TEXT REFERENCES categories(id);

ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

-- Dynamic client registration (RFC 7591). Public clients only; PKCE required.
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,           -- client_id
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,              -- JSON array
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,          -- SHA-256 of the authorization code
  client_id      TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,             -- PKCE S256
  scope          TEXT NOT NULL DEFAULT 'mcp',
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE oauth_tokens (
  id                 TEXT PRIMARY KEY,
  token_hash         TEXT NOT NULL UNIQUE,  -- SHA-256 of the access token
  refresh_hash       TEXT UNIQUE,           -- SHA-256 of the refresh token
  client_id          TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  scope              TEXT NOT NULL DEFAULT 'mcp',
  expires_at         TEXT NOT NULL,
  refresh_expires_at TEXT,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_oauth_tokens_agent ON oauth_tokens (agent_id);
