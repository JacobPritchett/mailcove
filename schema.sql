-- mailcove message store (metadata + search; bodies/attachments live in R2)
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,         -- internal uuid
  thread_id       TEXT,                     -- grouping key (root message-id or self)
  direction       TEXT NOT NULL,            -- 'in' | 'out'
  folder          TEXT NOT NULL,            -- 'inbox' | 'sent'
  msg_from        TEXT,
  msg_to          TEXT,
  msg_cc          TEXT,
  subject         TEXT,
  snippet         TEXT,
  date            INTEGER NOT NULL,         -- epoch ms
  unread          INTEGER NOT NULL DEFAULT 1,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  message_id      TEXT,                     -- RFC822 Message-ID header
  in_reply_to     TEXT,
  r2_raw_key      TEXT,
  state           TEXT NOT NULL DEFAULT 'inbox',
  starred         INTEGER NOT NULL DEFAULT 0,
  trashed_at      INTEGER,
  domain          TEXT,
  pre_trash_state TEXT,                         -- state before trash, for restore
  category        TEXT,                         -- AI auto-label (primary|promotions|updates|social); NULL = uncategorized
  dmarc_pass      INTEGER NOT NULL DEFAULT 0,  -- 1 = DMARC passed on ingest; gates remote image auto-load
  from_addr       TEXT                          -- authenticated sender mailbox (parsed.from.address); image-allowlist key
);

CREATE INDEX IF NOT EXISTS idx_messages_folder_date ON messages(folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread      ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread      ON messages(folder, unread);
CREATE INDEX IF NOT EXISTS idx_messages_state_date    ON messages(state, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_state_trashed ON messages(state, trashed_at);
CREATE INDEX IF NOT EXISTS idx_messages_starred       ON messages(starred);
CREATE INDEX IF NOT EXISTS idx_messages_domain        ON messages(domain);
CREATE INDEX IF NOT EXISTS idx_messages_category      ON messages(category);

-- Multi-domain registry: one row per connected domain. See migrations/0007.
CREATE TABLE IF NOT EXISTS domains (
  domain          TEXT PRIMARY KEY,   -- identity (apex) domain, lowercase
  zone_id         TEXT,               -- Cloudflare zone id
  sending_domain  TEXT,               -- onboarded Email Sending domain (transport From), NULL = no sending
  receive_mode    TEXT,               -- 'inbox' | 'forward' | 'external' | 'off' (informational cache)
  forward_copy_to TEXT,               -- per-domain forward-copy override; NULL = global FORWARD_COPY_TO
  display_name    TEXT,               -- From display name default for this identity
  created         INTEGER NOT NULL
);

-- Inbox filters/rules (auto-actions on inbound mail). See migrations/0006.
CREATE TABLE IF NOT EXISTS filters (
  id        TEXT PRIMARY KEY,
  field     TEXT NOT NULL,
  op        TEXT NOT NULL,
  value     TEXT NOT NULL,
  action    TEXT NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 1,
  position  INTEGER NOT NULL DEFAULT 0,
  created   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_filters_enabled ON filters(enabled, position);

-- Web Push subscriptions (one row per opted-in device). See migrations/0005.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created    INTEGER NOT NULL
);

-- Full-text search index (subject + participants + full body). Kept in sync by
-- the Worker on ingest/send/delete; rebuildable via reindexAll(). See
-- migrations/0003-search-fts.sql.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  subject,
  participants,
  body,
  tokenize = 'porter unicode61'
);

-- Per-sender remote-image allowlist. Address is normalized (lowercased) before
-- insert/compare. See migrations/0010-images.sql.
CREATE TABLE IF NOT EXISTS image_senders (
  address    TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Drafts: autosaved compose state (dialog + inline reply). body_json holds the
-- rich editor document (TipTap JSON, stringified); body_text is the plain
-- mirror for list snippets. Client-generated ids; PUT upserts. See
-- migrations/0008-drafts.sql.
CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT,
  in_reply_to TEXT,
  msg_to      TEXT,
  subject     TEXT,
  body_text   TEXT,
  body_json   TEXT,
  from_local  TEXT,
  from_domain TEXT,
  from_name   TEXT,
  updated     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated DESC);

-- Registry of Email Routing rules this inbox created, keyed by (zone, rule id).
-- Ownership source of truth for toggling/deleting a rule (the `rule:` name
-- marker is a fallback for pre-registry rules). See migrations/0009 and
-- isOwnedRule in src/cf_routing.ts.
CREATE TABLE IF NOT EXISTS managed_routing_rules (
  zone_id  TEXT NOT NULL,
  rule_id  TEXT NOT NULL,
  created  INTEGER NOT NULL,
  PRIMARY KEY (zone_id, rule_id)
);
