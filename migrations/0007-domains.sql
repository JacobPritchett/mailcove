-- Multi-domain registry: one row per connected domain. `sending_domain` is the
-- Email Sending domain authorized as the outbound transport From for this
-- identity domain (the apex itself when the apex is onboarded, else a
-- send.<apex> subdomain). NULL sending_domain = sending not enabled yet.
CREATE TABLE IF NOT EXISTS domains (
  domain          TEXT PRIMARY KEY,   -- identity (apex) domain, lowercase
  zone_id         TEXT,               -- Cloudflare zone id
  sending_domain  TEXT,               -- onboarded Email Sending domain (transport From), NULL = no sending
  receive_mode    TEXT,               -- 'inbox' | 'forward' | 'external' | 'off' (informational cache)
  forward_copy_to TEXT,               -- per-domain forward-copy override; NULL = global FORWARD_COPY_TO
  display_name    TEXT,               -- From display name default for this identity
  created         INTEGER NOT NULL
);

-- Example seed row. Replace these values with your own domain, or remove this
-- INSERT and add your domain through the in-app onboarding flow after first run.
INSERT OR IGNORE INTO domains (domain, zone_id, sending_domain, receive_mode, display_name, created)
VALUES ('example.com', '00000000000000000000000000000000', 'send.example.com', 'inbox', 'Mailcove', 1765238400000);
