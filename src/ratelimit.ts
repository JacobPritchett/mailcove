// Tiny in-isolate token-bucket limiter. Best-effort (per-isolate, not global),
// used as defense-in-depth against a scripted client hammering an expensive
// endpoint — the real auth boundary is still Cloudflare Access.

export interface Bucket { tokens: number; last: number; }

/**
 * Consume one token for `key`, refilling continuously. Returns true if allowed.
 * `now` is passed in so callers (and tests) stay deterministic.
 */
export function takeToken(
  buckets: Map<string, Bucket>,
  key: string,
  now: number,
  capacity = 8,
  refillPerSec = 3,
): boolean {
  const b = buckets.get(key) ?? { tokens: capacity, last: now };
  // Refill based on elapsed time, capped at capacity.
  b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
