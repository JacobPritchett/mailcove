// Server-side conversation list. Collapses messages into one row per thread_id
// with accurate aggregates (replaces the page-bounded client groupByThread).

export const VIEWS = ["inbox", "starred", "sent", "all", "trash"] as const;
export type View = (typeof VIEWS)[number];
const VIEW_SET = new Set<string>(VIEWS);
export function isView(x: unknown): x is View { return typeof x === "string" && VIEW_SET.has(x); }

export function viewWhere(view: View): string {
  switch (view) {
    case "inbox":   return "direction='in' AND state='inbox'";
    case "starred": return "starred=1 AND state!='trash'";
    case "sent":    return "direction='out' AND state!='trash'";
    case "all":     return "state!='trash'";
    case "trash":   return "state='trash'";
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
  /** Identity domain of the latest message (multi-domain inbox). */
  domain: string | null;
}

interface ViewEnv { DB: D1Database; }

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
): Promise<ThreadListRow[]> {
  const where = viewWhere(view);
  // The latest-message fields use correlated subqueries; the outer GROUP BY
  // applies the same view predicate once more.
  const subFields = ["id", "msg_from", "msg_to", "subject", "snippet", "category", "domain"];
  const subSelects = subFields
    .map((f) => `(SELECT ${f} FROM messages x WHERE x.thread_id=m.thread_id AND (${where}) ORDER BY x.date DESC LIMIT 1) AS ${f}`)
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
  const filter = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  binds.push(limit);
  const sql = `SELECT * FROM (${grouped}) ${filter} ORDER BY date DESC LIMIT ?`;
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
        WHERE direction='in' AND state='inbox'
        GROUP BY COALESCE(domain, '')
        ORDER BY domain ASC`,
    ).all<DomainCount>();
    return results ?? [];
  } catch {
    return [];
  }
}

export interface ViewCounts { inbox: number; starred: number; sent: number; all: number; trash: number; inboxUnread: number; }

export async function countsByView(env: ViewEnv): Promise<ViewCounts> {
  const one = async (where: string) => {
    const r = await env.DB.prepare(`SELECT COUNT(DISTINCT thread_id) AS n FROM messages WHERE ${where}`).first<{ n: number }>();
    return r?.n ?? 0;
  };
  const [inbox, starred, sent, all, trash, inboxUnread] = await Promise.all([
    one(viewWhere("inbox")), one(viewWhere("starred")), one(viewWhere("sent")),
    one(viewWhere("all")), one(viewWhere("trash")),
    one("direction='in' AND state='inbox' AND unread=1"),
  ]);
  return { inbox, starred, sent, all, trash, inboxUnread };
}
