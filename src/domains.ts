// Connected-domain registry (D1 `domains` table) + outbound sender resolution.
//
// The registry is the source of truth for which identity domains this inbox can
// SEND as, and which Email Sending domain carries the transport From for each.
// Two shapes exist in the wild:
//   - apex onboarded for sending  → sending_domain === domain. From IS the
//     identity (hello@example.com); no Reply-To needed.
//   - send.<apex> onboarded       → sending_domain = "send.<apex>". The From
//     header must live on the authorized subdomain, so the apex identity rides
//     on Reply-To (and is what we store/display) — the original Mailcove setup.

export interface DomainsEnv {
  DB: D1Database;
  INBOX_DOMAIN: string;
  FROM_DOMAIN: string;
  DEFAULT_FROM_LOCAL: string;
}

export interface DomainRow {
  domain: string;
  zone_id: string | null;
  sending_domain: string | null;
  receive_mode: string | null;
  forward_copy_to: string | null;
  display_name: string | null;
}

/** One selectable From identity for the compose picker. */
export interface SendIdentity {
  /** Identity (apex) domain — what the recipient should see and reply to. */
  domain: string;
  /** Onboarded Email Sending domain that carries the transport From header. */
  sendingDomain: string;
  /** Default From display name for this identity. */
  displayName: string;
}

/** Same local-part sanitization as the legacy fromLocal path (src/index.ts). */
export function sanitizeLocal(value: unknown): string {
  return String(value ?? "").replace(/[^a-z0-9._-]/gi, "");
}

/**
 * Sanitize a From display name before it reaches an outbound header or the
 * registry: control characters (CR/LF would be header injection) collapse to
 * spaces, invisible/bidi format characters are dropped (display spoofing),
 * RFC 2047 encoded-words are defanged (recipients' mail clients would DECODE
 * them into attacker-chosen rendered text), whitespace is normalized, and the
 * result is capped. "" means "no name" — callers fall back to the
 * identity/default name.
 */
export function sanitizeFromName(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // Zero-widths, LRM/RLM, bidi embedding/override/isolate controls, BOM:
    // invisible, only useful for spoofing what the recipient sees.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/gu, "")
    // Breaking the "=?" opener makes a smuggled encoded-word render literally
    // instead of being decoded by the recipient's mail client.
    .replace(/=\?/g, "=")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/**
 * Identity-domain rows that can send (sending_domain set), merged with the
 * env-configured default identity. The env identity is ALWAYS sendable — it's
 * exactly what the legacy no-`from` path authorizes — so including it here adds
 * no authority, makes `from: local@INBOX_DOMAIN` equivalent to the legacy path,
 * and keeps sending alive when the table is empty/missing (pre-migration) or a
 * transient D1 failure blanks the registry (non-default identities then fail
 * CLOSED with a 400 rather than silently re-routing).
 */
export async function listIdentities(env: DomainsEnv): Promise<SendIdentity[]> {
  // All rows, not just sendable ones: a row may carry ONLY a display_name (the
  // sender-name profile for the env-default identity, whose transport comes
  // from env vars rather than the registry).
  let rows: DomainRow[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT domain, zone_id, sending_domain, receive_mode, forward_copy_to, display_name
         FROM domains ORDER BY domain ASC`,
    ).all<DomainRow>();
    rows = r.results ?? [];
  } catch {
    rows = [];
  }
  const out: SendIdentity[] = rows
    .filter((r) => r.sending_domain)
    .map((r) => ({
      domain: r.domain,
      sendingDomain: r.sending_domain as string,
      displayName: sanitizeFromName(r.display_name) || defaultDisplayName(r.domain),
    }));
  // A registry row for the default domain takes precedence over the env pair.
  const envDomain = env.INBOX_DOMAIN.toLowerCase();
  if (!out.some((i) => i.domain.toLowerCase() === envDomain)) {
    const profile = rows.find((r) => r.domain.toLowerCase() === envDomain);
    out.push({
      domain: env.INBOX_DOMAIN,
      sendingDomain: env.FROM_DOMAIN,
      // Custom sender name when one is saved; else derived ("Mailcove" for the
      // current config) so a re-configured INBOX_DOMAIN doesn't inherit another
      // product's name.
      displayName:
        sanitizeFromName(profile?.display_name) || defaultDisplayName(env.INBOX_DOMAIN),
    });
  }
  out.sort((a, b) => a.domain.localeCompare(b.domain));
  return out;
}

// DDL mirror of migrations/0007-domains.sql. The connect flows bootstrap the
// table on first use (CREATE TABLE IF NOT EXISTS is a no-op once it exists), so
// user-driven onboarding works even before the migration file is applied.
const DOMAINS_DDL = `CREATE TABLE IF NOT EXISTS domains (
  domain          TEXT PRIMARY KEY,
  zone_id         TEXT,
  sending_domain  TEXT,
  receive_mode    TEXT,
  forward_copy_to TEXT,
  display_name    TEXT,
  created         INTEGER NOT NULL
)`;

export async function ensureDomainsTable(env: { DB: D1Database }): Promise<void> {
  await env.DB.prepare(DOMAINS_DDL).run();
}

export interface DomainUpsert {
  domain: string;
  zoneId?: string;
  sendingDomain?: string;
  receiveMode?: string;
}

/**
 * Insert-or-update a registry row, only touching the fields provided (an
 * onboarding step for sending must not clobber receive state, and vice versa).
 */
export async function upsertDomain(env: { DB: D1Database }, u: DomainUpsert, now: number): Promise<void> {
  await ensureDomainsTable(env);
  await env.DB.prepare(
    `INSERT INTO domains (domain, zone_id, sending_domain, receive_mode, created)
     VALUES (?,?,?,?,?)
     ON CONFLICT(domain) DO UPDATE SET
       zone_id        = COALESCE(excluded.zone_id, domains.zone_id),
       sending_domain = COALESCE(excluded.sending_domain, domains.sending_domain),
       receive_mode   = COALESCE(excluded.receive_mode, domains.receive_mode)`,
  )
    .bind(u.domain.toLowerCase(), u.zoneId ?? null, u.sendingDomain ?? null, u.receiveMode ?? null, now)
    .run();
}

/** One registry row, or null (missing row OR missing table). */
export async function getDomainRow(env: { DB: D1Database }, domain: string): Promise<DomainRow | null> {
  try {
    const r = await env.DB.prepare(
      `SELECT domain, zone_id, sending_domain, receive_mode, forward_copy_to, display_name
         FROM domains WHERE domain = ?`,
    )
      .bind(domain.toLowerCase())
      .first<DomainRow>();
    return r ?? null;
  } catch {
    return null;
  }
}

/**
 * Per-domain forward-copy override. Semantics of `forward_copy_to`:
 *   NULL = use the global FORWARD_COPY_TO default · "" = no copy · address = copy there.
 * Unlike upsertDomain (which COALESCEs), this sets the column EXPLICITLY,
 * including back to NULL.
 */
export async function setDomainForwardCopy(
  env: { DB: D1Database },
  domain: string,
  value: string | null,
  now: number,
): Promise<void> {
  await ensureDomainsTable(env);
  await env.DB.prepare(
    `INSERT INTO domains (domain, forward_copy_to, created) VALUES (?,?,?)
     ON CONFLICT(domain) DO UPDATE SET forward_copy_to = excluded.forward_copy_to`,
  )
    .bind(domain.toLowerCase(), value, now)
    .run();
}

/**
 * Per-identity From display name ("sending profile"). NULL = use the derived
 * default. Like setDomainForwardCopy, this sets the column EXPLICITLY,
 * including back to NULL. Callers sanitize before storing.
 */
export async function setDomainDisplayName(
  env: { DB: D1Database },
  domain: string,
  value: string | null,
  now: number,
): Promise<void> {
  await ensureDomainsTable(env);
  await env.DB.prepare(
    `INSERT INTO domains (domain, display_name, created) VALUES (?,?,?)
     ON CONFLICT(domain) DO UPDATE SET display_name = excluded.display_name`,
  )
    .bind(domain.toLowerCase(), value, now)
    .run();
}

/**
 * The forward-copy address for an inbound domain: the registry override when
 * set ("" = explicitly off), else the global default. Best-effort — a D1
 * failure falls back to the global default so mail flow never breaks.
 */
export async function forwardCopyFor(
  env: { DB: D1Database },
  domain: string,
  globalDefault: string | undefined,
): Promise<string | undefined> {
  const row = await getDomainRow(env, domain);
  if (row && row.forward_copy_to !== null && row.forward_copy_to !== undefined) {
    return row.forward_copy_to || undefined; // "" → no copy
  }
  return globalDefault || undefined;
}

/**
 * Domains connected for receiving into this inbox (registry rows with
 * receive_mode='inbox'). Empty when the table is missing — the sidebar then
 * derives its list purely from stored mail.
 */
export async function listReceivingDomains(env: { DB: D1Database }): Promise<string[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT domain FROM domains WHERE receive_mode='inbox' ORDER BY domain ASC`,
    ).all<{ domain: string }>();
    return (r.results ?? []).map((x) => x.domain);
  } catch {
    return [];
  }
}

/** "example.com" → "Example" — a humane default From display name. */
export function defaultDisplayName(domain: string): string {
  const label = domain.split(".")[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface ResolvedSender {
  /** Transport From address (on the authorized Email Sending domain). */
  fromAddr: string;
  /** User-facing identity address — stored, displayed, and replied to. */
  identityAddr: string;
  /** Identity domain — stored on the sent row's `domain` column. */
  domain: string;
  /** Set only when the transport domain differs from the identity domain. */
  replyTo?: string;
  displayName: string;
}

export class SenderError extends Error {}

/**
 * Resolve the outbound sender for /api/send.
 *  - `from` ("local@domain") picks a registry identity; unknown domains or empty
 *    local parts are rejected (never silently fall back to a different sender).
 *  - no `from` → legacy path: `fromLocal` on the env default identity.
 */
export async function resolveSender(
  env: DomainsEnv,
  from: unknown,
  fromLocal: unknown,
): Promise<ResolvedSender> {
  if (typeof from === "string" && from.trim() !== "") {
    const at = from.lastIndexOf("@");
    if (at <= 0) throw new SenderError("invalid 'from' address");
    const local = sanitizeLocal(from.slice(0, at));
    const domain = from.slice(at + 1).trim().toLowerCase();
    if (!local) throw new SenderError("invalid 'from' address");
    const identities = await listIdentities(env);
    const identity = identities.find((i) => i.domain.toLowerCase() === domain);
    if (!identity) throw new SenderError(`sending is not enabled for '${domain}'`);
    return buildSender(local, identity);
  }
  const local = sanitizeLocal(fromLocal || env.DEFAULT_FROM_LOCAL) || "hello";
  // The legacy path's TRANSPORT stays pinned to env config (it's the fail-safe
  // path and must work with no/broken registry), but the sender-name profile is
  // honored best-effort (getDomainRow returns null on any D1 trouble).
  const profile = await getDomainRow(env, env.INBOX_DOMAIN);
  return buildSender(local, {
    domain: env.INBOX_DOMAIN,
    sendingDomain: env.FROM_DOMAIN,
    // "Mailcove" under the current config — the historical legacy-path default.
    displayName:
      sanitizeFromName(profile?.display_name) || defaultDisplayName(env.INBOX_DOMAIN),
  });
}

function buildSender(local: string, identity: SendIdentity): ResolvedSender {
  const identityAddr = `${local}@${identity.domain}`;
  const fromAddr = `${local}@${identity.sendingDomain}`;
  const sameDomain = identity.sendingDomain.toLowerCase() === identity.domain.toLowerCase();
  return {
    fromAddr,
    identityAddr,
    domain: identity.domain,
    // When the apex itself is the authorized sender, From IS the identity and a
    // Reply-To would be redundant noise; only set it for send.* transports.
    replyTo: sameDomain ? undefined : identityAddr,
    displayName: identity.displayName,
  };
}
