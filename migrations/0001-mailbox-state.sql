-- Spec 1: mailbox actions & state. Adds lifecycle/flag/domain columns.
-- SQLite ALTER ADD COLUMN is non-destructive; apply this file exactly once.
ALTER TABLE messages ADD COLUMN state TEXT NOT NULL DEFAULT 'inbox';
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN trashed_at INTEGER;
ALTER TABLE messages ADD COLUMN domain TEXT;

-- Backfill domain: inbound uses recipient (msg_to), outbound uses sender (msg_from).
UPDATE messages
SET domain = lower(
  substr(
    CASE WHEN direction='out' THEN msg_from ELSE msg_to END,
    instr(CASE WHEN direction='out' THEN msg_from ELSE msg_to END, '@') + 1
  )
)
WHERE domain IS NULL
  AND instr(CASE WHEN direction='out' THEN msg_from ELSE msg_to END, '@') > 0;

CREATE INDEX IF NOT EXISTS idx_messages_state_date    ON messages(state, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_state_trashed ON messages(state, trashed_at);
CREATE INDEX IF NOT EXISTS idx_messages_starred       ON messages(starred);
CREATE INDEX IF NOT EXISTS idx_messages_domain        ON messages(domain);
