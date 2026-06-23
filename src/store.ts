// D1/R2 helpers kept out of the router to keep index.ts thin.

export interface StoreEnv {
  DB: D1Database;
  MAILSTORE: R2Bucket;
}

// Same column set the list/detail endpoints expose, so thread rows are shaped
// identically to /api/messages rows for the frontend.
const THREAD_COLS =
  "id, thread_id, direction, folder, msg_from, msg_to, msg_cc, subject, snippet, date, unread, has_attachments, message_id, in_reply_to, state, starred, domain, dmarc_pass, from_addr";

interface ThreadBody {
  text: string;
  html: string;
  attachments: { partId?: string; name: string; mimeType: string; size: number; disposition?: string; contentId?: string | null }[];
}

const EMPTY_BODY: ThreadBody = { text: "", html: "", attachments: [] };

/**
 * Look up the thread_id of the earliest stored message whose RFC Message-ID is
 * one of `candidateIds`. Used to join an inbound reply to an existing thread
 * (our own sent message, or an earlier inbound) when its parent is already in
 * the DB. Returns the *earliest* (date ASC) match so a reply collapses onto the
 * thread root rather than a mid-chain message. Returns null when there are no
 * candidates (no query is issued) or nothing matches.
 */
export async function findThreadIdByMessageIds(
  db: D1Database,
  candidateIds: string[],
): Promise<string | null> {
  if (candidateIds.length === 0) return null;
  const placeholders = candidateIds.map(() => "?").join(",");
  const row = await db
    .prepare(
      `SELECT thread_id FROM messages WHERE message_id IN (${placeholders}) ORDER BY date ASC LIMIT 1`,
    )
    .bind(...candidateIds)
    .first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

/**
 * Load every message (inbox + sent) sharing `threadId`, ordered oldest→newest,
 * each enriched with its body loaded from R2 `parsed/<id>.json`. Ordering is
 * delegated to SQL (date ASC); body loads run concurrently to avoid an N+1
 * waterfall.
 *
 * NOTE: bodies are loaded eagerly (one R2 GET per message), so this endpoint
 * fans out R2 reads proportional to thread length. The LIMIT bounds that fan-out
 * for personal-scale threads; a future optimization is lazy per-message body
 * loading (return rows immediately, fetch each body on demand).
 */
export async function getThread(env: StoreEnv, threadId: string) {
  const { results } = await env.DB.prepare(
    `SELECT ${THREAD_COLS} FROM messages WHERE thread_id=? ORDER BY date ASC LIMIT 100`,
  )
    .bind(threadId)
    .all();

  const rows = (results ?? []) as Record<string, unknown>[];

  const messages = await Promise.all(
    rows.map(async (row) => {
      const obj = await env.MAILSTORE.get(`parsed/${row.id}.json`);
      const body = obj ? ((await obj.json()) as ThreadBody) : EMPTY_BODY;
      return { ...row, body };
    }),
  );

  return { thread_id: threadId, messages };
}
