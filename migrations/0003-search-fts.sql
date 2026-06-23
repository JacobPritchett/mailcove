-- Spec C: full-text search. An FTS5 virtual table over each message's subject,
-- participants (from/to/cc), and full body text. The Worker keeps it in sync on
-- ingest/send/delete (best-effort); reindexAll() rebuilds it from R2.
--
-- Apply exactly once, THEN backfill. New mail self-indexes with full body text;
-- existing mail is backfilled here from D1 columns (subject/participants) +
-- snippet as a body proxy. For full-body backfill of old mail, trigger the
-- Worker's reindex (reads R2). message_id is UNINDEXED — stored for mapping
-- back to messages.id, not searched.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  subject,
  participants,
  body,
  tokenize = 'porter unicode61'
);

-- Backfill existing messages (metadata + snippet). Safe to re-run: clears first.
DELETE FROM messages_fts;
INSERT INTO messages_fts (message_id, subject, participants, body)
SELECT
  id,
  COALESCE(subject, ''),
  TRIM(COALESCE(msg_from, '') || ' ' || COALESCE(msg_to, '') || ' ' || COALESCE(msg_cc, '')),
  COALESCE(snippet, '')
FROM messages;
