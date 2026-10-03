-- Base tables as they stood before 0001. Every later migration ALTERs
-- `messages`, but nothing in this directory ever created it (the first install
-- used schema.sql directly), so `wrangler d1 migrations apply` on an EMPTY
-- database failed at 0001 with "no such table: messages".
--
-- CREATE ... IF NOT EXISTS only: on a database that already has these objects
-- (production, where 0001 onwards are recorded as applied) this is a no-op.
-- Keep it that way. Columns added by 0001 and later do NOT belong here.
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
  r2_raw_key      TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_folder_date ON messages(folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread      ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread      ON messages(folder, unread);
