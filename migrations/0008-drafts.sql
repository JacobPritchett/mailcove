-- Drafts: autosaved compose state (dialog + inline reply). body_json holds the
-- rich editor document (TipTap JSON, stringified) for faithful resume;
-- body_text is the plain mirror used for list snippets and as a resume
-- fallback. Client-generated ids; PUT upserts make autosave idempotent.
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
