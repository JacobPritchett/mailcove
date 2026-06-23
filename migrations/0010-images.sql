-- Safe images: per-sender auto-show allowlist + captured DMARC verdict.
-- image_senders: From addresses the user trusts to auto-load remote images.
-- Address is normalized (lowercased local@domain) before insert/compare.
-- dmarc_pass gates auto-show: a spoofed From (DMARC fail) never auto-loads,
-- even if the address is on the allowlist.
CREATE TABLE IF NOT EXISTS image_senders (
  address    TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

ALTER TABLE messages ADD COLUMN dmarc_pass INTEGER NOT NULL DEFAULT 0;
