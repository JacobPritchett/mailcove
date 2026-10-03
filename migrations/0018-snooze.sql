-- Snooze. `snoozed_until` hides a thread's inbox messages until that time
-- (epoch ms); `woke_at` records when a snooze ended, so the thread comes back
-- at the top of the inbox instead of at its original date.
ALTER TABLE messages ADD COLUMN snoozed_until INTEGER;
ALTER TABLE messages ADD COLUMN woke_at INTEGER;

-- The cron asks "what is due?" every few minutes; only snoozed rows are indexed.
CREATE INDEX IF NOT EXISTS idx_messages_snoozed ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL;
