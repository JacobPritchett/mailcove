-- Inbox filters/rules: auto-apply an action to newly received mail that matches
-- a simple condition (field contains/equals value). Applied at ingest by
-- src/rules.ts. Lowest position wins ties; all matching rules apply in order.
CREATE TABLE IF NOT EXISTS filters (
  id        TEXT PRIMARY KEY,
  field     TEXT NOT NULL,     -- 'from' | 'to' | 'subject'
  op        TEXT NOT NULL,     -- 'contains' | 'equals'
  value     TEXT NOT NULL,
  action    TEXT NOT NULL,     -- 'archive' | 'trash' | 'star' | 'read'
  enabled   INTEGER NOT NULL DEFAULT 1,
  position  INTEGER NOT NULL DEFAULT 0,
  created   INTEGER NOT NULL   -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_filters_enabled ON filters(enabled, position);
