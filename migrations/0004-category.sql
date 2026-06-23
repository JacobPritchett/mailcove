-- AI auto-labels: a coarse category for each inbound message, assigned by
-- Workers AI at ingest (see src/categorize.ts). NULL = uncategorized (older mail
-- or a classify failure) — treated as "primary" in the UI.
ALTER TABLE messages ADD COLUMN category TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_category ON messages(category);
