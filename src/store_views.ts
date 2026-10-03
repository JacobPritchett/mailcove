// Server-side conversation list. Collapses messages into one row per thread_id
// with accurate aggregates (replaces the page-bounded client groupByThread).

export const VIEWS = ["inbox", "starred", "sent", "all", "trash", "spam", "snoozed"] as const;
export type View = (typeof VIEWS)[number];
const VIEW_SET = new Set<string>(VIEWS);
export function isView(x: unknown): x is View { return typeof x === "string" && VIEW_SET.has(x); }

/**
 * The row predicate for a view. `now` only matters for the two views that
 * depend on the clock: a snoozed message is out of the inbox until its time
 * passes, and it comes back the moment it does, with no job needed to move it.
 * `now` is an integer we produce, never caller text, so it is safe to inline.
 */
export function viewWhere(view: View, now: number = Date.now()): string {
  const t = Math.floor(now);
  switch (view) {
    case "inbox":   return `direction='in' AND state='inbox' AND (snoozed_until IS NULL OR snoozed_until <= ${t})`;
    case "snoozed": return `state='inbox' AND snoozed_until > ${t}`;
    case "starred": return "starred=1 AND state!='trash'";
    case "sent":    return "direction='out' AND state!='trash'";
    case "all":     return "state!='trash'";
    // Junk is trash with a mark, so the two views split the trash state.
    case "trash":   return "state='trash' AND spam=0";
    case "spam":    return "state='trash' AND spam=1";
  }
}

/** The fixed AI auto-label set, mirrored from src/categorize.ts for filtering. */
export const CATEGORIES = ["primary", "promotions", "updates", "social"] as const;
export type Category = (typeof CATEGORIES)[number];
const CATEGORY_SET = new Set<string>(CATEGORIES);
export function isCategory(x: unknown): x is Category { return typeof x === "string" && CATEGORY_SET.has(x); }

export interface ThreadListRow {
  thread_id: string; id: string; msg_from: string; msg_to: string;
  subject: string; snippet: string; date: number; count: number;
  anyUnread: 0 | 1; hasAttachments: 0 | 1; starred: 0 | 1;
  category: string | null;
  /** List position: the latest message's date, or when a snooze ended if later. */
  sort_date?: number;
  /** Latest snooze time in the thread, when one is set. */
  snoozedUntil?: number | null;
  /** Identity domain of the latest message (multi-domain inbox). */
  domain: string | null;
}

interface ViewEnv { DB: D1Database; }

/** Where a list page left off. */
export interface ListCursor { date: number; threadId: string; }

/** Page size bounds for the list endpoint. */
export const DEFAULT_PAGE_SIZE = 200;
export const MAX_PAGE_SIZE = 200;

/** Parse `?limit=`: an integer in 1..MAX_PAGE_SIZE, else the default. */
export function parsePageSize(raw: string | null): number {
  if (raw === null || !/^\d{1,4}$/.test(raw)) return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  return n >= 1 && n <= MAX_PAGE_SIZE ? n : DEFAULT_PAGE_SIZE;
}

/**
 * The opaque `cursor` a list response hands back and a client returns for the
 * next page. Two shapes, because the two list orders differ: views are ordered
 * by date (keyset, `d.<date>.<thread id>`), search by relevance (`o.<offset>`).
 * Returns null for anything malformed, which the route answers with a 400
 * rather than silently restarting from the top.
 */
export type PageCursor = { kind: "date"; after: ListCursor } | { kind: "offset"; offset: number };

export function encodeDateCursor(row: { date: number; sort_date?: number; thread_id: string }): string {
  return `d.${row.sort_date ?? row.date}.${encodeURIComponent(row.thread_id)}`;
}
export function encodeOffsetCursor(offset: number): string {
  return `o.${offset}`;
}
export function parseCursor(raw: string): PageCursor | null {
  if (raw.length > 1200) return null;
  const offset = /^o\.(\d{1,7})$/.exec(raw);
  if (offset) return { kind: "offset", offset: Number(offset[1]) };
  const date = /^d\.(\d{1,16})\.(.+)$/.exec(raw);
  if (!date) return null;
  try {
    return { kind: "date", after: { date: Number(date[1]), threadId: decodeURIComponent(date[2]) } };
  } catch {
    return null;
  }
}

/** Loose hostname check for the ?domain= filter (defense-in-depth at the route). */
export function isDomainName(x: unknown): x is string {
  return typeof x === "string" && /^[a-z0-9][a-z0-9.-]{0,253}$/i.test(x);
}

// Per-view conversation list, newest first. Free-text search is a separate
// path (FTS5 — see searchThreads in src/search.ts); this builds the plain view.
// An optional `category` narrows to threads whose LATEST message carries that
// AI auto-label (NULL counts as "primary"); an optional `domain` narrows to
// threads whose latest message belongs to that identity domain.
export async function listThreadsByView(
  env: ViewEnv,
  view: View,
  limit = 200,
  category?: Category,
  domain?: string,
  /** Pass true when `domain` is the default inbox domain so legacy NULL-domain rows match it. */
  domainIncludesNull = false,
  /** Resume after this row: the (date, thread_id) of the last thread already listed. */
  after?: ListCursor,
  now: number = Date.now(),
): Promise<ThreadListRow[]> {
  const where = viewWhere(view, now);
  const t = Math.floor(now);
  // The latest-message fields use correlated subqueries; the outer GROUP BY
  // applies the same view predicate once more.
  const subFields = ["id", "msg_from", "msg_to", "subject", "snippet", "category", "domain"];
  const subSelects = subFields
    // INDEXED BY: left to itself (D1 keeps no planner statistics) SQLite walks
    // the state/date index looking for one thread, per field, per thread, and
    // a 16k-message mailbox took 25 s to list. Pinned to the thread index the
    // same list takes milliseconds.
    .map((f) => `(SELECT ${f} FROM messages x INDEXED BY idx_messages_thread WHERE x.thread_id=m.thread_id AND (${where}) ORDER BY x.date DESC LIMIT 1) AS ${f}`)
    .join(",\n      ");
  // The grouped query exposes `category` as a derived column (latest-message
  // value). Filter it in an OUTER query so the predicate references the derived
  // column unambiguously — referencing the alias directly in HAVING can instead
  // bind to the base messages.category (an arbitrary grouped row), which would
  // let a thread pass the filter on a value different from the chip we display.
  const grouped = `
    SELECT
      m.thread_id AS thread_id,
      ${subSelects},
      MAX(m.date) AS date,
      -- A thread whose snooze ended sorts by when it woke (recorded by the cron
      -- in woke_at, or still sitting in snoozed_until if the cron has not run).
      MAX(MAX(m.date), COALESCE(MAX(m.woke_at), 0), COALESCE(MAX(CASE WHEN m.snoozed_until <= ${t} THEN m.snoozed_until END), 0)) AS sort_date,
      MAX(CASE WHEN m.snoozed_until > ${t} THEN m.snoozed_until END) AS snoozedUntil,
      COUNT(*) AS count,
      MAX(m.unread) AS anyUnread,
      MAX(m.has_attachments) AS hasAttachments,
      MAX(m.starred) AS starred
    FROM messages m
    WHERE (${where})
    GROUP BY m.thread_id`;
  // "primary" also matches NULL (uncategorized). Binds (category?, domain?)
  // precede the LIMIT bind, in clause order.
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (category === "primary") {
    conditions.push("(category = 'primary' OR category IS NULL)");
  } else if (category) {
    conditions.push("category = ?");
    binds.push(category);
  }
  if (domain) {
    conditions.push(domainIncludesNull ? "(domain = ? OR domain IS NULL)" : "domain = ?");
    binds.push(domain.toLowerCase());
  }
  if (after) {
    // Keyset, not OFFSET: new mail arriving between two page loads shifts every
    // offset by one and would repeat or skip a thread. The thread id breaks
    // ties between threads whose latest messages share a millisecond.
    conditions.push("(sort_date < ? OR (sort_date = ? AND thread_id < ?))");
    binds.push(after.date, after.date, after.threadId);
  }
  const filter = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  binds.push(limit);
  const sql = `SELECT * FROM (${grouped}) ${filter} ORDER BY sort_date DESC, thread_id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<ThreadListRow>();
  return results ?? [];
}

export interface DomainCount { domain: string; threads: number; unread: number; }

/**
 * Inbox thread/unread counts per identity domain, for the sidebar's inbox
 * switcher. NULL domains group under "" (legacy rows). Best-effort: a failure
 * degrades to [] (no switcher) rather than breaking the counts endpoint.
 */
export async function countsByDomain(env: ViewEnv): Promise<DomainCount[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT COALESCE(domain, '') AS domain,
              COUNT(DISTINCT thread_id) AS threads,
              COUNT(DISTINCT CASE WHEN unread=1 THEN thread_id END) AS unread
         FROM messages
        WHERE ${viewWhere("inbox")}
        GROUP BY COALESCE(domain, '')
        ORDER BY domain ASC`,
    ).all<DomainCount>();
    return results ?? [];
  } catch {
    return [];
  }
}

export interface ViewCounts { inbox: number; starred: number; sent: number; all: number; trash: number; spam: number; snoozed: number; inboxUnread: number; }

export async function countsByView(env: ViewEnv): Promise<ViewCounts> {
  const one = async (where: string) => {
    const r = await env.DB.prepare(`SELECT COUNT(DISTINCT thread_id) AS n FROM messages WHERE ${where}`).first<{ n: number }>();
    return r?.n ?? 0;
  };
  const now = Date.now();
  const [inbox, starred, sent, all, trash, spam, snoozed, inboxUnread] = await Promise.all([
    one(viewWhere("inbox", now)), one(viewWhere("starred")), one(viewWhere("sent")),
    one(viewWhere("all")), one(viewWhere("trash")), one(viewWhere("spam")), one(viewWhere("snoozed", now)),
    one(`${viewWhere("inbox", now)} AND unread=1`),
  ]);
  return { inbox, starred, sent, all, trash, spam, snoozed, inboxUnread };
}
