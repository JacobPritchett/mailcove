-- Per-identity signature, appended to new messages composed from that identity.
-- Stored as PLAIN TEXT: it is seeded into the compose body, and keeping it text
-- means it can never carry markup into an outgoing HTML message.
ALTER TABLE domains ADD COLUMN signature TEXT;
