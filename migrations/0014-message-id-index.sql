-- Every inbound message looks up its parents by RFC Message-ID to find the
-- thread it belongs to (findThreadIdByMessageIds in src/store.ts). Without an
-- index that is a full scan of `messages` on the delivery path.
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
