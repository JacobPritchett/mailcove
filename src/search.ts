// Full-text search over messages, backed by a SQLite FTS5 virtual table
// (`messages_fts`). Each message contributes its subject, participants
// (from/to/cc), and full body text. Search is bm25-ranked and prefix-matched.
//
// Design notes:
// - FTS writes are BEST-EFFORT. A failure to index must never break mail
//   ingest or sending — search is auxiliary and can always be rebuilt with
//   reindexAll(). So ftsUpsert/ftsDelete swallow their own errors.
// - User query text is sanitized into a fixed token grammar before it touches
//   FTS5 MATCH (only `"token"*` atoms), so nothing a user types can be parsed
//   as FTS5 syntax/operators (no injection, no "no such column" errors).

import { htmlToText } from "./htmlText";
import type { ThreadListRow } from "./store_views";
import { buildSearchSql, parseSearchQuery } from "./searchQuery";

interface SearchEnv { DB: D1Database; }
interface ReindexEnv { DB: D1Database; MAILSTORE: R2Bucket; }

/** Max query tokens — keeps the MATCH expression bounded regardless of input. */
const MAX_TOKENS = 12;

/**
 * Turn free user text into a safe FTS5 MATCH expression: each alphanumeric
 * (unicode-aware) token becomes a quoted prefix atom `"tok"*`, AND-joined.
 * Returns null when there are no usable tokens (caller returns no results).
 */
export function toFtsMatch(q: string): string | null {
  const tokens = q.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.slice(0, MAX_TOKENS).map((t) => `"${t}"*`).join(" ");
}

/** Flatten a message body for indexing: prefer plain text, else the text of
 *  the HTML (htmlToText: linear, and without stylesheet or script contents). */
export function bodyForIndex(text: string, html: string): string {
  const raw = text && text.trim() ? text : htmlToText(html);
  return raw.replace(/\s+/g, " ").trim();
}

export interface FtsRow {
  message_id: string;
  subject: string;
  participants: string;
  body: string;
}

/** Assemble an FTS row from a message's fields (participants = from+to+cc). */
export function ftsRowFrom(args: {
  id: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  bodyText: string;
}): FtsRow {
  return {
    message_id: args.id,
    subject: args.subject || "",
    participants: [args.from, args.to, args.cc].filter(Boolean).join(" "),
    body: args.bodyText || "",
  };
}

/**
 * Upsert one message into the FTS index (delete-then-insert, so it's safe to
 * call on both fresh inserts and reindex). Best-effort — returns false on any
 * DB error instead of throwing, so callers in the mail path are never broken.
 */
export async function ftsUpsert(env: SearchEnv, row: FtsRow): Promise<boolean> {
  try {
    await env.DB.prepare(`DELETE FROM messages_fts WHERE message_id=?`).bind(row.message_id).run();
    await env.DB
      .prepare(`INSERT INTO messages_fts (message_id, subject, participants, body) VALUES (?,?,?,?)`)
      .bind(row.message_id, row.subject, row.participants, row.body)
      .run();
    return true;
  } catch (e) {
    console.error("fts upsert failed:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Remove messages from the FTS index by id. Best-effort per id. */
export async function ftsDelete(env: SearchEnv, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await env.DB.prepare(`DELETE FROM messages_fts WHERE message_id=?`).bind(id).run();
    } catch (e) {
      console.error("fts delete failed:", e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Search → thread-collapsed list rows. Free text is bm25-ranked through FTS5;
 * operators (from:, has:attachment, before:, ...) narrow by message columns.
 * Trash is excluded unless the query says `in:trash`. Mirrors the ThreadListRow
 * shape produced by listThreadsByView so the client renders results with the
 * same list component. See searchQuery.ts for the grammar and the SQL shape.
 */
export async function searchThreads(
  env: SearchEnv,
  q: string,
  limit = 200,
  opts: { offset?: number; domain?: string; domainIncludesNull?: boolean; now?: number; tzOffsetMin?: number } = {},
): Promise<ThreadListRow[]> {
  const parsed = parseSearchQuery(q, opts.now, opts.tzOffsetMin);
  if (parsed.empty) return [];
  const { sql, binds } = buildSearchSql(parsed, {
    limit,
    offset: opts.offset,
    domain: opts.domain,
    domainIncludesNull: opts.domainIncludesNull,
  });
  const { results } = await env.DB.prepare(sql).bind(...binds).all<ThreadListRow>();
  return results ?? [];
}

/**
 * The thread ids a search matches, in result order, without the display rows:
 * the same parse and the same statement as searchThreads with the per-thread
 * lookups left out, so offset N here is offset N there.
 */
export async function searchThreadIds(
  env: SearchEnv,
  q: string,
  limit: number,
  opts: { offset?: number; domain?: string; domainIncludesNull?: boolean; now?: number; tzOffsetMin?: number } = {},
): Promise<string[]> {
  const parsed = parseSearchQuery(q, opts.now, opts.tzOffsetMin);
  if (parsed.empty) return [];
  const { sql, binds } = buildSearchSql(parsed, {
    limit,
    offset: opts.offset,
    domain: opts.domain,
    domainIncludesNull: opts.domainIncludesNull,
    idsOnly: true,
  });
  const { results } = await env.DB.prepare(sql).bind(...binds).all<{ thread_id: string }>();
  return (results ?? []).map((r) => r.thread_id);
}

/**
 * Rebuild the entire FTS index from scratch: clear it, then re-index every
 * message, pulling full body text from R2 (parsed/<id>.json). Used as a
 * one-time backfill after the migration and to recover from drift. Messages
 * whose R2 body is missing are indexed on metadata only.
 *
 * Scope/assumptions (this is an admin, behind-Access, occasional operation on a
 * small single-tenant mailbox):
 * - It clears the index up front, so search returns nothing for the (brief)
 *   duration of a rebuild. Acceptable for a manual admin trigger; steady-state
 *   indexing is incremental via ftsUpsert and never clears.
 * - It reads R2 serially (one get per message) and inserts per row. That's
 *   O(messages) subrequests in a single invocation — fine at this inbox's size.
 *   If the store ever grows to thousands of messages, move this to a
 *   cursor/queue-driven job (chunked R2 reads + batched D1 writes) to stay under
 *   the Worker subrequest/CPU limits.
 */
export async function reindexAll(env: ReindexEnv): Promise<{ indexed: number }> {
  const { results } = await env.DB
    .prepare(`SELECT id, subject, msg_from, msg_to, msg_cc FROM messages`)
    .all<{ id: string; subject: string | null; msg_from: string | null; msg_to: string | null; msg_cc: string | null }>();
  const rows = results ?? [];
  await env.DB.prepare(`DELETE FROM messages_fts`).run();
  let indexed = 0;
  for (const r of rows) {
    let bodyText = "";
    try {
      const obj = await env.MAILSTORE.get(`parsed/${r.id}.json`);
      if (obj) {
        const b = (await obj.json()) as { text?: string; html?: string };
        bodyText = bodyForIndex(b.text || "", b.html || "");
      }
    } catch {
      /* body missing/unreadable → index metadata only */
    }
    const row = ftsRowFrom({
      id: r.id,
      subject: r.subject || "",
      from: r.msg_from || "",
      to: r.msg_to || "",
      cc: r.msg_cc || "",
      bodyText,
    });
    await env.DB
      .prepare(`INSERT INTO messages_fts (message_id, subject, participants, body) VALUES (?,?,?,?)`)
      .bind(row.message_id, row.subject, row.participants, row.body)
      .run();
    indexed++;
  }
  return { indexed };
}
