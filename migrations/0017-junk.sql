-- Junk mail. A junked message is a trashed one with a mark: it leaves every
-- view and search exactly as trash does and is purged on the same 30-day clock,
-- but lists under Junk instead of Trash. Kept as a flag on top of the trash
-- state, not a state of its own, so nothing that already excludes trash needs
-- to learn about a second excluded state.
ALTER TABLE messages ADD COLUMN spam INTEGER NOT NULL DEFAULT 0;

-- Senders whose mail goes straight to Junk. `address` is a lowercased mailbox
-- ("a@b.example") or a whole domain written "@b.example".
-- "Have I heard from this sender before?" is asked once per inbound message.
CREATE INDEX IF NOT EXISTS idx_messages_from_addr ON messages(from_addr);

CREATE TABLE IF NOT EXISTS blocked_senders (
  address TEXT PRIMARY KEY,
  created INTEGER NOT NULL
);
