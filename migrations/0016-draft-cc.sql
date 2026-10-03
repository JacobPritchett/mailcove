-- Drafts keep Cc and Bcc alongside To, so a half-written message resumes with
-- everyone it was addressed to. Nullable, no backfill: existing drafts have none.
ALTER TABLE drafts ADD COLUMN msg_cc TEXT;
ALTER TABLE drafts ADD COLUMN msg_bcc TEXT;
