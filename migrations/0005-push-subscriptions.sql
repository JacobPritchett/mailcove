-- Web Push subscriptions. One row per browser/device that opted in. The endpoint
-- is the unique push service URL; p256dh + auth are the client public key and
-- shared secret used to encrypt the payload (RFC 8291). See src/push.ts.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created    INTEGER NOT NULL  -- epoch ms
);
