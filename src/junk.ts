// Junk mail: the blocked-senders list and the "do I know this sender?" test
// that keeps the automatic verdict away from real correspondence.
//
// The rule that matters: a false positive (real mail hidden in Junk) costs far
// more than a false negative (one more message in the inbox). So nothing here
// junks mail on a guess alone. A message goes to Junk when the user blocked its
// sender, or when the classifier calls it junk AND it failed DMARC AND it is
// not part of a conversation the user took part in (see shouldAutoJunk).

interface JunkEnv { DB: D1Database; INBOX_DOMAIN?: string; FROM_DOMAIN?: string }

/** Most blocked entries kept; the list is a personal block list, not a feed. */
export const MAX_BLOCKED = 1000;

const ADDRESS = /^[^\s@<>,;"()]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/;
const DOMAIN = /^@([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/;

/** Normalize a block entry to "a@b.example" or "@b.example"; null when unusable. */
export function normalizeBlockEntry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length > 320) return null;
  if (!ADDRESS.test(v) && !DOMAIN.test(v)) return null;
  // "@co.uk" is not a sender. (An address AT such a suffix is fine.)
  if (v.startsWith("@") && isSharedSuffix(v.slice(1))) return null;
  return v;
}

// Suffixes under which unrelated organisations register names. Blocking one
// would junk a large slice of all mail, and nobody means that. Not the full
// public suffix list (which is huge and changes): the common ones, plus the
// rule below that an entry needs at least two labels.
const SHARED_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "or.jp",
  "com.br", "com.mx", "com.ar", "co.in", "co.za", "com.cn", "com.tw", "com.hk", "com.sg", "co.kr", "com.tr",
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "herokuapp.com", "blogspot.com", "appspot.com",
]);

/** True when a block entry names a shared suffix rather than one sender or organisation. */
export function isSharedSuffix(domain: string): boolean {
  return !domain.includes(".") || SHARED_SUFFIXES.has(domain);
}

/**
 * Is `domain` one of ours, a subdomain of one, or a parent of one? All three
 * would junk mail we send ourselves (transport subdomains such as send.<apex>
 * included), so none can be blocked.
 */
export function isOwnDomain(domain: string, own: Set<string>): boolean {
  for (const o of own) {
    if (domain === o || domain.endsWith(`.${o}`) || o.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/** The domain a block entry applies to. */
export function blockEntryDomain(entry: string): string {
  return entry.slice(entry.lastIndexOf("@") + 1);
}

/** Every domain this inbox receives for: blocking one would junk our own mail. */
export async function ownDomains(env: JunkEnv): Promise<Set<string>> {
  const own = new Set<string>();
  if (env.INBOX_DOMAIN) own.add(env.INBOX_DOMAIN.toLowerCase());
  if (env.FROM_DOMAIN) own.add(env.FROM_DOMAIN.toLowerCase());
  try {
    const { results } = await env.DB.prepare(`SELECT domain, sending_domain FROM domains`).all<{ domain: string; sending_domain: string | null }>();
    for (const r of results ?? []) {
      own.add(String(r.domain).toLowerCase());
      if (r.sending_domain) own.add(String(r.sending_domain).toLowerCase());
    }
  } catch {
    // No registry yet: the default domain is the only one.
  }
  return own;
}

export async function listBlocked(env: JunkEnv): Promise<{ address: string; created: number }[]> {
  const { results } = await env.DB
    .prepare(`SELECT address, created FROM blocked_senders ORDER BY created DESC LIMIT ?`)
    .bind(MAX_BLOCKED)
    .all<{ address: string; created: number }>();
  return results ?? [];
}

export async function addBlocked(env: JunkEnv, entry: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO blocked_senders (address, created) VALUES (?, ?)`).bind(entry, now).run();
}

export async function removeBlocked(env: JunkEnv, entry: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM blocked_senders WHERE address = ?`).bind(entry).run();
}

export async function countBlocked(env: JunkEnv): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM blocked_senders`).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Is this sender blocked? `fromAddr` must be the From mailbox from the
 * structured parse (messages.from_addr), never the rendered From string: a
 * display name is free text and could otherwise be used to get someone else's
 * mail junked, or to dodge a block. Note what this is and is not: a block
 * matches what mail CLAIMS to be from. Mail forging a blocked address is
 * junked too (fine), and a determined sender can change address (no block
 * list stops that). A domain entry covers its subdomains.
 */
export async function isBlocked(env: JunkEnv, fromAddr: string): Promise<boolean> {
  const addr = fromAddr.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  const labels = addr.slice(at + 1).split(".").filter(Boolean);
  // a.b.example -> @a.b.example, @b.example (never a bare TLD), bounded depth.
  const candidates = [addr];
  for (let i = 0; i < labels.length - 1 && i < 6; i++) candidates.push(`@${labels.slice(i).join(".")}`);
  const row = await env.DB
    .prepare(`SELECT 1 AS hit FROM blocked_senders WHERE address IN (${candidates.map(() => "?").join(",")}) LIMIT 1`)
    .bind(...candidates)
    .first<{ hit: number }>();
  return !!row;
}

/**
 * Should a message the classifier called junk actually be moved to Junk?
 *
 * Only when two independent signals agree: the model's opinion, and the mail
 * arriving with nothing vouching for it (no SPF, DKIM or DMARC pass at the
 * boundary, or an outright DMARC fail). One small model reading a subject line
 * is not enough to hide someone's first message, a verification code or an
 * invoice; mail that authenticated but that the model dislikes stays in the
 * inbox, where the user can junk or block it in one tap. And never inside a
 * conversation the user has taken part in.
 *
 * History with the sender is deliberately NOT consulted: From is whatever the
 * sender typed, so for unauthenticated mail "I have written to this address"
 * proves nothing, and for authenticated mail this function already says no.
 */
export async function shouldAutoJunk(env: JunkEnv, args: { vouchedFor: boolean; threadId: string }): Promise<boolean> {
  if (args.vouchedFor) return false;
  try {
    const mine = await env.DB
      .prepare(`SELECT 1 AS hit FROM messages WHERE thread_id=? AND direction='out' LIMIT 1`)
      .bind(args.threadId)
      .first<{ hit: number }>();
    return !mine;
  } catch (e) {
    // The only thing this gates is hiding mail, so a failed lookup hides nothing.
    console.error("auto-junk lookup failed:", e instanceof Error ? e.message : String(e));
    return false;
  }
}
