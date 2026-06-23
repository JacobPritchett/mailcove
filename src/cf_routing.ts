// Cloudflare Email Routing + Email Sending client for the "Domains" admin
// dashboard and its onboarding flows.
//
// Reads: lists the account's zones and, per zone, surfaces Email Routing
// settings, forwarding rules, the catch-all, verified destinations, MX, and
// Email Sending domains.
//
// Writes (each narrowly scoped, every one behind UI confirmation + the
// zoneInAccount ownership guard):
//  - setCatchAll        — forward to a VERIFIED destination, drop, or deliver to
//                         this inbox Worker (worker name is server-configured,
//                         never client input).
//  - enableRouting      — turns on Email Routing for a zone. This DOES add
//                         MX+SPF DNS records, so the route layer refuses it for
//                         any zone whose apex MX points at another mail provider
//                         (hasForeignApexMx) — we never displace external mail.
//  - onboardSending     — onboards a domain for Email Sending (records live on
//                         cf-bounce.<domain>; no apex MX involved). Idempotent.
//  - ensureDnsRecords   — CREATE-only DNS reconciliation for the expected
//                         sending records; never modifies or deletes, and never
//                         touches an existing _dmarc policy.
// The CF token may be broadly scoped, so do NOT widen this surface without an
// explicit feature + review.

const CF_API = "https://api.cloudflare.com/client/v4";

/** Env subset this module needs — a CF API token + the account id. */
export interface CfEnv {
  /** Cloudflare API token (secret). Read scopes: Zone:Read, Email Routing, DNS:Read. */
  CF_API_TOKEN?: string;
  /** Account id the zones live under. */
  CF_ACCOUNT_ID?: string;
  /**
   * D1 binding — backs the managed-rule registry (ownership source of truth for
   * toggle/delete). Optional so call sites/tests that only exercise CF-API paths
   * can omit it; when absent, ownership falls back to the rule name marker.
   */
  DB?: D1Database;
}

/** Thrown when the dashboard is hit but no CF token is configured. */
export class CfNotConfigured extends Error {
  constructor() {
    super("domains admin not configured (CF_API_TOKEN unset)");
    this.name = "CfNotConfigured";
  }
}

export interface DomainSummary {
  zoneId: string;
  name: string;
  zoneStatus: string;
  paused: boolean;
}

export interface RoutingMatcher { type: string; field?: string; value?: string; }
export interface RoutingAction { type: string; value?: string[]; }
export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority?: number;
  matchers: RoutingMatcher[];
  actions: RoutingAction[];
}
export interface CatchAll { enabled: boolean; actions: RoutingAction[]; }
export interface Destination { email: string; verified: boolean; }
export interface MxRecord { name: string; content: string; priority: number; }

export interface SendingDomain { id: string; name: string; enabled: boolean; }

export interface DomainDetail {
  zoneId: string;
  name: string;
  /** Email Routing settings, or null if routing was never provisioned for the zone. */
  routing: { enabled: boolean; status: string } | null;
  rules: RoutingRule[];
  catchAll: CatchAll | null;
  destinations: Destination[];
  mx: MxRecord[];
  /** Email Sending domains onboarded in this zone (apex and/or subdomains). */
  sending: SendingDomain[];
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: { code?: number; message?: string }[];
  result_info?: { page: number; total_pages: number };
}

function authHeaders(env: CfEnv): Record<string, string> {
  if (!env.CF_API_TOKEN) throw new CfNotConfigured();
  return { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" };
}

/**
 * GET a Cloudflare API path and return the parsed envelope. Throws on transport
 * failure or a non-2xx HTTP status; callers inspect `success`/`result` for
 * API-level outcomes (e.g. a zone with routing never provisioned).
 */
async function cfGet<T>(env: CfEnv, path: string): Promise<CfEnvelope<T>> {
  const res = await fetch(`${CF_API}${path}`, { headers: authHeaders(env) });
  if (!res.ok && res.status !== 404) {
    // 404 is a valid "not provisioned" signal for some routing endpoints; let it
    // through so callers can map it to null. Anything else is a real failure.
    throw new Error(`cf ${path} -> HTTP ${res.status}`);
  }
  return (await res.json()) as CfEnvelope<T>;
}

interface ZoneWire { id: string; name: string; status: string; paused?: boolean; }

/**
 * List every zone in the account (paginated). One cheap call set — used for the
 * dashboard's domain list. Per-zone routing detail is fetched lazily on click.
 */
export async function listDomains(env: CfEnv): Promise<DomainSummary[]> {
  if (!env.CF_ACCOUNT_ID) throw new CfNotConfigured();
  const out: DomainSummary[] = [];
  // Page through; per_page max is 50. A handful of pages covers the account.
  for (let page = 1; page <= 20; page++) {
    const env_ = await cfGet<ZoneWire[]>(
      env,
      `/zones?account.id=${env.CF_ACCOUNT_ID}&per_page=50&page=${page}&order=name&direction=asc`,
    );
    if (!env_.success) break;
    for (const z of env_.result || []) {
      out.push({ zoneId: z.id, name: z.name, zoneStatus: z.status, paused: !!z.paused });
    }
    const info = env_.result_info;
    if (!info || page >= info.total_pages) break;
  }
  return out;
}

interface RoutingSettingsWire { enabled?: boolean; status?: string; }

/**
 * Email Routing settings for a zone. Three outcomes, kept distinct so the UI
 * doesn't mislabel a working domain during a CF hiccup:
 *  - null                         → genuinely not provisioned (404 / success:false)
 *  - { status: "unknown" }        → the settings fetch FAILED (CF 5xx, network,
 *                                    token scope) — "couldn't load", NOT "absent"
 *  - { enabled, status }          → real settings
 */
export async function getRouting(env: CfEnv, zoneId: string): Promise<{ enabled: boolean; status: string } | null> {
  try {
    return await getRoutingStrict(env, zoneId);
  } catch {
    // A thrown error means a non-404 transport/HTTP failure — we couldn't read
    // the setting, which is different from it being absent. Surface that so the
    // badge can say "couldn't load" instead of a false "not set up".
    return { enabled: false, status: "unknown" };
  }
}

/**
 * STRICT routing read for mutation guards: null = genuinely not provisioned
 * (404); a transport/API failure THROWS so callers fail closed instead of
 * mutating on unknown state. Display paths use the lenient getRouting above.
 */
export async function getRoutingStrict(
  env: CfEnv,
  zoneId: string,
): Promise<{ enabled: boolean; status: string } | null> {
  const r = await cfGet<RoutingSettingsWire>(env, `/zones/${zoneId}/email/routing`);
  // cfGet lets a 404 through as success:false → that's a true "not provisioned".
  if (!r.success || !r.result) return null;
  return { enabled: !!r.result.enabled, status: r.result.status || "unknown" };
}

interface RuleWire {
  id?: string;
  tag?: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  matchers?: RoutingMatcher[];
  actions?: RoutingAction[];
}

function normalizeRule(w: RuleWire): RoutingRule {
  return {
    id: w.id || w.tag || "",
    name: w.name || "",
    enabled: !!w.enabled,
    priority: w.priority,
    matchers: Array.isArray(w.matchers) ? w.matchers : [],
    actions: Array.isArray(w.actions) ? w.actions : [],
  };
}

/** Custom forwarding rules for a zone (excludes the catch-all). Empty on failure. */
async function getRules(env: CfEnv, zoneId: string): Promise<RoutingRule[]> {
  try {
    const r = await cfGet<RuleWire[]>(env, `/zones/${zoneId}/email/routing/rules?per_page=50`);
    if (!r.success || !Array.isArray(r.result)) return [];
    // The catch-all can surface here too (matcher type "all"); the dedicated
    // catch_all fetch covers it, so drop any "all"-matcher rule from this list.
    return r.result
      .map(normalizeRule)
      .filter((rule) => !rule.matchers.some((m) => m.type === "all"));
  } catch {
    return [];
  }
}

/** The catch-all rule for a zone, or null if not provisioned. */
async function getCatchAll(env: CfEnv, zoneId: string): Promise<CatchAll | null> {
  try {
    const r = await cfGet<{ enabled?: boolean; actions?: RoutingAction[] }>(
      env,
      `/zones/${zoneId}/email/routing/rules/catch_all`,
    );
    if (!r.success || !r.result) return null;
    return { enabled: !!r.result.enabled, actions: Array.isArray(r.result.actions) ? r.result.actions : [] };
  } catch {
    return null;
  }
}

interface DestinationWire { email?: string; verified?: string | null; }

/** Account-level verified destination addresses (forwarding targets). Empty on failure. */
async function getDestinations(env: CfEnv): Promise<Destination[]> {
  if (!env.CF_ACCOUNT_ID) return [];
  try {
    const r = await cfGet<DestinationWire[]>(
      env,
      `/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses?per_page=50`,
    );
    if (!r.success || !Array.isArray(r.result)) return [];
    return r.result
      .filter((d): d is DestinationWire & { email: string } => typeof d.email === "string")
      .map((d) => ({ email: d.email, verified: !!d.verified }));
  } catch {
    return [];
  }
}

interface MxWire { name?: string; content?: string; priority?: number; }

/** MX records for a zone. Empty on failure. */
export async function getMx(env: CfEnv, zoneId: string): Promise<MxRecord[]> {
  try {
    return await getMxStrict(env, zoneId);
  } catch {
    return [];
  }
}

/**
 * STRICT MX read for mutation guards: THROWS when the records can't be read,
 * so the foreign-provider check never silently passes on a CF read failure.
 */
export async function getMxStrict(env: CfEnv, zoneId: string): Promise<MxRecord[]> {
  const r = await cfGet<MxWire[]>(env, `/zones/${zoneId}/dns_records?type=MX&per_page=100`);
  if (!r.success || !Array.isArray(r.result)) throw new Error("could not read MX records");
  return r.result.map((m) => ({
    name: m.name || "",
    content: m.content || "",
    priority: typeof m.priority === "number" ? m.priority : 0,
  }));
}

interface SendingDomainWire { id?: string; tag?: string; name?: string; enabled?: boolean; }

/** Email Sending domains onboarded in a zone. Empty on failure. */
export async function getSendingDomains(env: CfEnv, zoneId: string): Promise<SendingDomain[]> {
  try {
    const r = await cfGet<SendingDomainWire[]>(env, `/zones/${zoneId}/email/sending/subdomains`);
    if (!r.success || !Array.isArray(r.result)) return [];
    return r.result
      .filter((s): s is SendingDomainWire & { name: string } => typeof s.name === "string")
      .map((s) => ({ id: s.id || s.tag || "", name: s.name, enabled: !!s.enabled }));
  } catch {
    return [];
  }
}

/**
 * Full routing detail for a single zone — fetched lazily when a domain is
 * opened. Sub-fetches run in parallel and each degrades to a safe empty/null on
 * failure so one bad endpoint can't blank the whole panel.
 */
export async function getDomainDetail(env: CfEnv, zoneId: string, name: string): Promise<DomainDetail> {
  const [routing, rules, catchAll, destinations, mx, sending] = await Promise.all([
    getRouting(env, zoneId),
    getRules(env, zoneId),
    getCatchAll(env, zoneId),
    getDestinations(env),
    getMx(env, zoneId),
    getSendingDomains(env, zoneId),
  ]);
  return { zoneId, name, routing, rules, catchAll, destinations, mx, sending };
}

// ---- Writes (the only two; both reversible, both behind UI confirmation) ----

/** Non-GET CF request. Separate from cfGet so the read path stays GET-only. */
async function cfSend<T>(env: CfEnv, method: "POST" | "PUT", path: string, body: unknown): Promise<CfEnvelope<T>> {
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: authHeaders(env),
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok && res.status !== 404) throw new Error(`cf ${method} ${path} -> HTTP ${res.status}`);
  return (await res.json()) as CfEnvelope<T>;
}

export interface WriteResult { ok: boolean; error?: string }

/** Confirm a zone belongs to this account before any write (ownership guard). */
export async function zoneInAccount(env: CfEnv, zoneId: string): Promise<boolean> {
  return (await findZone(env, zoneId)) !== null;
}

/** Look up a zone (id + name) in this account; null when it isn't ours. */
export async function findZone(env: CfEnv, zoneId: string): Promise<DomainSummary | null> {
  const domains = await listDomains(env);
  return domains.find((d) => d.zoneId === zoneId) ?? null;
}

export interface CatchAllUpdate {
  action: "forward" | "drop" | "worker";
  forwardTo?: string;
  /** Server-configured Worker name — NEVER client input. */
  workerName?: string;
}

/**
 * Set the catch-all rule: forward to a VERIFIED destination, drop, or deliver
 * to this inbox's Worker. Forwarding to an unverified/unknown address is
 * refused (it wouldn't work and would silently black-hole mail); the worker
 * name comes from server config only. Reversible — re-run with another action.
 */
export async function setCatchAll(env: CfEnv, zoneId: string, update: CatchAllUpdate): Promise<WriteResult> {
  // Shared action builder: verified-destination check + server-config worker name.
  const actions = await buildActions(env, update);
  if (!Array.isArray(actions)) return { ok: false, error: actions.error };
  const r = await cfSend(env, "PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
    name: "catch-all",
    enabled: true,
    matchers: [{ type: "all" }],
    actions,
  });
  return { ok: !!r.success, error: r.success ? undefined : r.errors?.[0]?.message || "catch-all update failed" };
}

// ---- Per-address routing rules (custom forwarding) ----

export interface NewRule {
  /** Full address the rule matches (literal To). Zone-scoped by Cloudflare. */
  to: string;
  action: "forward" | "worker" | "drop";
  forwardTo?: string;
  /** Server-configured Worker name — NEVER client input. */
  workerName?: string;
}

/** Build the CF actions array for a rule/catch-all update, with the same
 * safety rails everywhere: forward targets must be verified, the worker name
 * must come from server config. */
async function buildActions(
  env: CfEnv,
  update: { action: "forward" | "worker" | "drop"; forwardTo?: string; workerName?: string },
): Promise<RoutingAction[] | { error: string }> {
  if (update.action === "drop") return [{ type: "drop" }];
  if (update.action === "worker") {
    const worker = (update.workerName || "").trim();
    if (!worker) return { error: "worker name required" };
    return [{ type: "worker", value: [worker] }];
  }
  const to = (update.forwardTo || "").trim();
  if (!to) return { error: "forward address required" };
  const dests = await getDestinations(env);
  const verified = dests.some((d) => d.email.toLowerCase() === to.toLowerCase() && d.verified);
  if (!verified) return { error: "destination is not a verified address" };
  return [{ type: "forward", value: [to] }];
}

/** Create a per-address routing rule (literal To matcher). */
export async function createRule(
  env: CfEnv,
  zoneId: string,
  rule: NewRule,
  now: number,
): Promise<WriteResult & { id?: string }> {
  const actions = await buildActions(env, rule);
  if (!Array.isArray(actions)) return { ok: false, error: actions.error };
  const r = await cfSend<RuleWire>(env, "POST", `/zones/${zoneId}/email/routing/rules`, {
    name: `${MANAGED_RULE_NAME_PREFIX}${rule.to}`,
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: rule.to }],
    actions,
  });
  if (!r.success) return { ok: false, error: r.errors?.[0]?.message || "rule create failed" };
  const id = r.result?.id || r.result?.tag || "";
  // Record ownership so a later toggle/delete trusts this rule by id, not by its
  // (spoofable) name/shape. Best-effort: a registry hiccup mustn't fail create.
  await recordManagedRule(env, zoneId, id, now);
  return { ok: true, id };
}

export interface RuleGuard {
  /** Zone apex — every matcher must target an address under it. */
  zoneName: string;
  /** This inbox's Worker name; the only worker a managed rule may target. */
  workerName?: string;
}

/**
 * Name marker stamped on every rule createRule() makes (`rule: <addr>`). Used
 * as the OWNERSHIP FALLBACK for rules created before the managed_routing_rules
 * registry existed (see isOwnedRule). Keep in sync with the name set in
 * createRule.
 */
const MANAGED_RULE_NAME_PREFIX = "rule: ";

// ---- Managed-rule registry (ownership source of truth) ----
// A rule whose (zoneId, id) we recorded at create time is unambiguously ours;
// shape/name can be spoofed, a registry row cannot. Registry writes are
// best-effort: a hiccup must not fail rule creation/deletion — the name marker
// still covers ownership, so we degrade rather than break.

/** Compact "name: message" rendering of a thrown value for logs. */
function errStr(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Record a rule this inbox just created so later toggle/delete can trust it.
 * Best-effort by design: a registry write failure must NOT fail rule creation,
 * because ownership degrades to the `rule:` name marker (the chosen "registry
 * OR marker" policy). But the failure is LOGGED — a silently-undersized
 * registry (migration 0009 not applied, D1 outage) is an operational signal
 * that the registry isn't protecting mutations, not something to swallow.
 */
async function recordManagedRule(env: CfEnv, zoneId: string, ruleId: string, now: number): Promise<void> {
  if (!env.DB || !ruleId) return;
  try {
    await env.DB.prepare(
      `INSERT INTO managed_routing_rules (zone_id, rule_id, created) VALUES (?,?,?)
       ON CONFLICT(zone_id, rule_id) DO NOTHING`,
    )
      .bind(zoneId, ruleId, now)
      .run();
  } catch (e) {
    // Degraded: this rule won't have a registry row and will rely on the name
    // marker for ownership. Surface it rather than failing the create.
    console.error(`managed-rule registry insert failed (${zoneId}/${ruleId}):`, errStr(e));
  }
}

/**
 * True when (zoneId, ruleId) is a rule this inbox recorded at create time. A
 * read failure returns false (→ ownership falls back to the name marker, per
 * the "registry OR marker" policy) but is LOGGED so a degraded registry is
 * visible instead of silently weakening the ownership check.
 */
async function isRuleRegistered(env: CfEnv, zoneId: string, ruleId: string): Promise<boolean> {
  if (!env.DB || !ruleId) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS one FROM managed_routing_rules WHERE zone_id=? AND rule_id=?`,
    )
      .bind(zoneId, ruleId)
      .first<{ one: number }>();
    return !!row;
  } catch (e) {
    console.error(`managed-rule registry read failed (${zoneId}/${ruleId}):`, errStr(e));
    return false;
  }
}

/** Drop a registry row after the rule is deleted (best-effort; logged on failure). */
async function forgetManagedRule(env: CfEnv, zoneId: string, ruleId: string): Promise<void> {
  if (!env.DB || !ruleId) return;
  try {
    await env.DB.prepare(`DELETE FROM managed_routing_rules WHERE zone_id=? AND rule_id=?`)
      .bind(zoneId, ruleId)
      .run();
  } catch (e) {
    console.error(`managed-rule registry delete failed (${zoneId}/${ruleId}):`, errStr(e));
  }
}

/**
 * Validate a fetched rule has the SHAPE this inbox creates: a simple literal-To
 * rule on `guard.zoneName`, with actions limited to drop / forward / this
 * inbox's Worker. This is necessary (a mutation must not replay/act on a shape
 * we don't understand) but NOT sufficient for ownership — a manual
 * `billing@zone -> forward` rule has the same shape. Ownership is decided by
 * isOwnedRule. Does NOT check destination verification (re-enable-specific).
 */
function isManagedShape(w: RuleWire, guard: RuleGuard): WriteResult {
  if (!Array.isArray(w.matchers) || !w.matchers.length || !Array.isArray(w.actions) || !w.actions.length) {
    return { ok: false, error: "rule shape not recognized" };
  }
  const zone = guard.zoneName.toLowerCase();
  const matchersOk = w.matchers.every(
    (m) =>
      m.type === "literal" &&
      m.field === "to" &&
      typeof m.value === "string" &&
      m.value.toLowerCase().endsWith(`@${zone}`),
  );
  if (!matchersOk) return { ok: false, error: "not a per-address rule for this domain" };
  for (const a of w.actions) {
    if (a.type === "drop") continue;
    if (a.type === "worker") {
      const values = a.value ?? [];
      if (!guard.workerName || !values.length || !values.every((v) => v === guard.workerName)) {
        return { ok: false, error: "rule targets a worker this inbox doesn't manage" };
      }
      continue;
    }
    if (a.type === "forward") continue;
    return { ok: false, error: `unsupported rule action: ${a.type}` };
  }
  return { ok: true };
}

/**
 * Authorize a toggle/delete of an existing rule. The rule MUST have a shape we
 * manage AND be one we own. Ownership = a registry row recorded at create time
 * (authoritative) OR — for rules created before the registry existed — our
 * `rule:` name marker (fallback). rule ids are exposed by getDomainDetail and
 * the UI offers Delete per row, so without this an enumerated id could mutate a
 * rule the app never created.
 */
async function isOwnedRule(env: CfEnv, zoneId: string, w: RuleWire, guard: RuleGuard): Promise<WriteResult> {
  const shape = isManagedShape(w, guard);
  if (!shape.ok) return shape;
  if (w.id && (await isRuleRegistered(env, zoneId, w.id))) return { ok: true };
  if (typeof w.name === "string" && w.name.startsWith(MANAGED_RULE_NAME_PREFIX)) return { ok: true };
  return { ok: false, error: "rule was not created by this inbox" };
}

/**
 * Enable/disable an existing rule (read-modify-write; CF's update is a full
 * PUT). The fetched rule is RE-VALIDATED before being replayed: only simple
 * literal-To rules on this zone, with actions limited to drop / forward-to-a-
 * verified-destination / this inbox's Worker. Anything else (a rule created
 * elsewhere with shapes we don't manage, a stale or unverified forward target
 * being re-enabled, a foreign worker) is refused rather than blindly PUT back.
 * `priority` is preserved so toggling never reorders rules.
 */
export async function setRuleEnabled(
  env: CfEnv,
  zoneId: string,
  ruleId: string,
  enabled: boolean,
  guard: RuleGuard,
): Promise<WriteResult> {
  const get = await cfGet<RuleWire>(env, `/zones/${zoneId}/email/routing/rules/${ruleId}`);
  if (!get.success || !get.result) return { ok: false, error: "rule not found" };
  const w = get.result;
  const owned = await isOwnedRule(env, zoneId, w, guard);
  if (!owned.ok) return owned;
  // Re-enabling must not revive a stale/since-unverified forward target.
  if (enabled) {
    for (const a of w.actions!) {
      if (a.type !== "forward") continue;
      const dests = await getDestinations(env);
      const values = a.value ?? [];
      const allVerified =
        values.length > 0 &&
        values.every((v) => dests.some((d) => d.email.toLowerCase() === v.toLowerCase() && d.verified));
      if (!allVerified) return { ok: false, error: "forward target is not a verified address" };
    }
  }
  const body: Record<string, unknown> = {
    name: w.name,
    enabled,
    matchers: w.matchers,
    actions: w.actions,
  };
  if (typeof w.priority === "number") body.priority = w.priority;
  const r = await cfSend(env, "PUT", `/zones/${zoneId}/email/routing/rules/${ruleId}`, body);
  return { ok: !!r.success, error: r.success ? undefined : r.errors?.[0]?.message || "rule update failed" };
}

/**
 * Delete a per-address routing rule. Read-before-delete: only a rule we OWN (a
 * registry row, or our name marker for pre-registry rules) AND whose shape we
 * manage may be removed, so an enumerated rule id can't be used to wipe a
 * foreign / manually-authored routing rule and silently break a domain's mail.
 * A 404 on the read = already gone (cfGet surfaces it as success:false) →
 * converged; a real read failure THROWS (fail closed, never "couldn't read,
 * delete anyway"). The registry row is dropped after a successful delete.
 */
export async function deleteRule(
  env: CfEnv,
  zoneId: string,
  ruleId: string,
  guard: RuleGuard,
): Promise<WriteResult> {
  const get = await cfGet<RuleWire>(env, `/zones/${zoneId}/email/routing/rules/${ruleId}`);
  if (!get.success || !get.result) {
    // Already gone → converged. Drop any stale registry row so it doesn't linger.
    await forgetManagedRule(env, zoneId, ruleId);
    return { ok: true };
  }
  const owned = await isOwnedRule(env, zoneId, get.result, guard);
  if (!owned.ok) return owned;
  const res = await fetch(`${CF_API}/zones/${zoneId}/email/routing/rules/${ruleId}`, {
    method: "DELETE",
    headers: authHeaders(env),
  });
  if (!res.ok && res.status !== 404) return { ok: false, error: `delete failed (HTTP ${res.status})` };
  const body = (await res.json().catch(() => null)) as CfEnvelope<unknown> | null;
  const ok = !!body?.success || res.status === 404; // already gone = converged
  if (ok) await forgetManagedRule(env, zoneId, ruleId);
  return { ok, error: ok ? undefined : body?.errors?.[0]?.message || "rule delete failed" };
}

/**
 * Register a new account-level forwarding destination. Cloudflare emails the
 * address a verification link; it becomes usable once verified.
 */
export async function createDestination(env: CfEnv, email: string): Promise<WriteResult> {
  if (!env.CF_ACCOUNT_ID) throw new CfNotConfigured();
  const r = await cfSend(env, "POST", `/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses`, { email });
  if (r.success) return { ok: true };
  const msg = r.errors?.[0]?.message || "";
  // Re-adding an existing destination converges (it may just resend the link).
  if (/exists/i.test(msg)) return { ok: true };
  return { ok: false, error: msg || "destination create failed" };
}

// ---- Onboarding writes ----

const CF_MX_SUFFIX = ".mx.cloudflare.net";

/**
 * True when the zone's APEX has MX records pointing somewhere other than
 * Cloudflare Email Routing (e.g. Google Workspace). Enabling routing on such a
 * zone would fight a live mail provider, so the receiving flow refuses it —
 * this is the safety gate that makes one-click onboarding safe to offer at all.
 */
export function hasForeignApexMx(mx: MxRecord[], zoneName: string): boolean {
  const apex = zoneName.toLowerCase();
  return mx.some((m) => {
    if (m.name.toLowerCase() !== apex) return false;
    const host = m.content.toLowerCase().replace(/\.$/, "");
    return !host.endsWith(CF_MX_SUFFIX);
  });
}

/**
 * Enable Email Routing for a zone (adds Cloudflare MX+SPF records on the apex).
 * Idempotent — enabling an already-enabled zone succeeds. Callers MUST run the
 * hasForeignApexMx guard first; this function is transport only.
 */
export async function enableRouting(env: CfEnv, zoneId: string): Promise<WriteResult> {
  const r = await cfSend(env, "POST", `/zones/${zoneId}/email/routing/enable`, {});
  return { ok: !!r.success, error: r.success ? undefined : r.errors?.[0]?.message || "enable routing failed" };
}

/**
 * Onboard a domain (apex or subdomain of the zone) for Email Sending.
 * Idempotent: "Subdomain already exists" (code 2040) resolves to the existing
 * record. Returns the sending-domain id for the DNS reconciliation step.
 */
export async function onboardSending(
  env: CfEnv,
  zoneId: string,
  name: string,
): Promise<WriteResult & { id?: string }> {
  const r = await cfSend<SendingDomainWire>(env, "POST", `/zones/${zoneId}/email/sending/subdomains`, { name });
  if (r.success) return { ok: true, id: r.result?.id || r.result?.tag || "" };
  const already = (r.errors || []).some((e) => e.code === 2040);
  if (already) {
    const existing = (await getSendingDomains(env, zoneId)).find(
      (s) => s.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return { ok: true, id: existing.id };
  }
  return { ok: false, error: r.errors?.[0]?.message || "sending onboarding failed" };
}

export interface DnsRecord { name: string; type: string; content: string; priority?: number; ttl?: number; }

/** Expected DNS records for an onboarded sending domain. Throws on failure. */
export async function getSendingDns(env: CfEnv, zoneId: string, sendingId: string): Promise<DnsRecord[]> {
  const r = await cfGet<DnsRecord[]>(env, `/zones/${zoneId}/email/sending/subdomains/${sendingId}/dns`);
  if (!r.success || !Array.isArray(r.result)) throw new Error("could not load expected sending DNS");
  return r.result;
}

interface ZoneDnsWire { name?: string; type?: string; content?: string; }

/**
 * Every DNS record in the zone, fully paginated. THROWS on any failed page —
 * an incomplete view must never be mistaken for "records absent" (that would
 * make the reconciler duplicate records or stack a second DMARC policy).
 */
async function listAllDnsRecords(env: CfEnv, zoneId: string): Promise<ZoneDnsWire[]> {
  const out: ZoneDnsWire[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await cfGet<ZoneDnsWire[]>(env, `/zones/${zoneId}/dns_records?per_page=500&page=${page}`);
    if (!r.success || !Array.isArray(r.result)) throw new Error("could not list zone DNS records");
    out.push(...r.result);
    const info = r.result_info;
    if (!info || page >= info.total_pages) break;
  }
  return out;
}

/**
 * CREATE-only DNS reconciliation: add any of `expected` that the zone is
 * missing. Never modifies or deletes records, and never adds a _dmarc record
 * when ANY TXT already exists at that name (an existing DMARC policy wins).
 * `skipDmarc` skips _dmarc creation entirely — used for zones whose mail is
 * hosted elsewhere, where we must not set a policy on their behalf.
 * Comparison is by (type, name) for TXT-like records and (type, name, content)
 * for MX (several MX share a name). THROWS if the zone's records can't be
 * listed (fail closed — see listAllDnsRecords).
 */
export async function ensureDnsRecords(
  env: CfEnv,
  zoneId: string,
  expected: DnsRecord[],
  opts: { skipDmarc?: boolean } = {},
): Promise<{ created: number; skipped: number; errors: string[] }> {
  const existing = (await listAllDnsRecords(env, zoneId)).map((x) => ({
    name: (x.name || "").toLowerCase().replace(/\.$/, ""),
    type: (x.type || "").toUpperCase(),
    content: (x.content || "").toLowerCase().replace(/\.$/, ""),
  }));
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const rec of expected) {
    const name = rec.name.toLowerCase().replace(/\.$/, "");
    const type = rec.type.toUpperCase();
    const content = rec.content.toLowerCase().replace(/\.$/, "").replace(/^"|"$/g, "");
    const isDmarc = type === "TXT" && name.startsWith("_dmarc.");
    const has = existing.some((e) => {
      if (e.type !== type || e.name !== name) return false;
      if (type === "MX") return e.content === content;
      return true; // one TXT per name is enough — never stack/overwrite policies
    });
    // An existing _dmarc TXT of ANY content is an explicit policy — leave it.
    // And with skipDmarc we don't set a policy at all (externally-hosted mail).
    const dmarcConflict = isDmarc && existing.some((e) => e.type === "TXT" && e.name === name);
    if (has || dmarcConflict || (isDmarc && opts.skipDmarc)) {
      skipped++;
      continue;
    }
    const body: Record<string, unknown> = {
      type,
      name: rec.name,
      content: rec.content.replace(/^"|"$/g, ""),
      ttl: rec.ttl && rec.ttl > 0 ? rec.ttl : 1,
    };
    if (type === "MX") body.priority = typeof rec.priority === "number" ? rec.priority : 10;
    const res = await cfSend(env, "POST", `/zones/${zoneId}/dns_records`, body);
    if (res.success) created++;
    else errors.push(`${type} ${rec.name}: ${res.errors?.[0]?.message || "create failed"}`);
  }
  return { created, skipped, errors };
}
