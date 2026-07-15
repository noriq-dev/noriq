-- Device authorization grant (RFC 8628) — lets input-constrained / headless clients
-- (the Noriq Runner daemon on an SSH-only box) authorize on a second device. The
-- device polls /oauth/token with device_code while a human approves user_code at
-- /oauth/device. Rows are short-lived (DEVICE_TTL_S) and single-use.

CREATE TABLE oauth_device_codes (
  device_code_hash TEXT PRIMARY KEY,            -- SHA-256 of the device_code (never stored raw)
  user_code        TEXT NOT NULL UNIQUE,        -- the short human-typed code, e.g. BCDF-GHJK
  client_id        TEXT NOT NULL REFERENCES oauth_clients(id),
  scope            TEXT NOT NULL DEFAULT 'mcp',
  interval_s       INTEGER NOT NULL DEFAULT 5,  -- min poll spacing; slow_down bumps it
  -- Set once a human resolves the code at the verification page.
  user_id          TEXT REFERENCES users(id),
  agent_id         TEXT REFERENCES agents(id),
  approved_at      TEXT,
  denied_at        TEXT,
  -- Set when the device successfully exchanges it — enforces single use.
  consumed_at      TEXT,
  last_polled_at   TEXT,                        -- drives slow_down enforcement
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_oauth_device_codes_user_code ON oauth_device_codes (user_code);
CREATE INDEX idx_oauth_device_codes_expires ON oauth_device_codes (expires_at);
