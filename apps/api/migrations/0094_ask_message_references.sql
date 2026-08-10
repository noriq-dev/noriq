-- Explicit composer selections are durable routing metadata. Raw @/# characters in message text
-- remain ordinary text; only these bounded, server-normalized records may scope an Ask turn.
ALTER TABLE ask_messages ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ask_generations ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
