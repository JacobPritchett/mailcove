-- Tombstones for permanently deleted mail. Purge and delete-forever remove the
-- `messages` row first (so a concurrent restore either keeps row and content or
-- finds no row), which leaves the search entry and the R2 objects to clean up
-- afterwards. This table is the record of that outstanding work: a tombstone is
-- written in the same transaction as the row delete and removed only once the
-- cleanup for that id has fully succeeded. See drainPendingDeletes in
-- src/store_mutations.ts.
CREATE TABLE IF NOT EXISTS pending_deletes (
  id         TEXT PRIMARY KEY,   -- the deleted message's id
  r2_raw_key TEXT,               -- its raw .eml key, if it had one
  created    INTEGER NOT NULL    -- epoch ms; bumped when a cleanup attempt fails
);
