// Draft storage (D1 `drafts` table): autosaved compose state for the dialog
// and the inline reply composer. Same self-bootstrapping pattern as the
// domains registry — the DDL mirrors migrations/0008-drafts.sql so autosave
// works before the migration file is ever applied.

export interface DraftRow {
  id: string;
  thread_id: string | null;
  in_reply_to: string | null;
  msg_to: string | null;
  subject: string | null;
  body_text: string | null;
  body_json: string | null;
  from_local: string | null;
  from_domain: string | null;
  from_name: string | null;
  updated: number;
}

const DRAFTS_DDL = `CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT,
  in_reply_to TEXT,
  msg_to      TEXT,
  subject     TEXT,
  body_text   TEXT,
  body_json   TEXT,
  from_local  TEXT,
  from_domain TEXT,
  from_name   TEXT,
  updated     INTEGER NOT NULL
)`;

export async function ensureDraftsTable(env: { DB: D1Database }): Promise<void> {
  await env.DB.prepare(DRAFTS_DDL).run();
}

/** Client-generated draft ids: uuid-ish, conservative charset. */
export function isDraftId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

// Size caps: autosave payloads are user-typed, but keep a hard ceiling so a
// runaway client (or a paste bomb) can't bloat D1 rows.
export const DRAFT_LIMITS = {
  to: 2_000,
  subject: 1_000,
  bodyText: 100_000,
  bodyJson: 400_000,
  threadId: 256,
  inReplyTo: 998, // RFC 5322 line limit
  fromLocal: 64,
  fromDomain: 253,
  fromName: 100,
} as const;

export interface DraftUpsert {
  id: string;
  threadId?: string;
  inReplyTo?: string;
  to?: string;
  subject?: string;
  bodyText?: string;
  bodyJson?: string;
  fromLocal?: string;
  fromDomain?: string;
  fromName?: string;
}

/** Validate + normalize an autosave body. Returns an error string when bad. */
export function validateDraft(b: Record<string, unknown>): { draft: DraftUpsert } | { error: string } {
  if (!isDraftId(b.id)) return { error: "invalid draft id" };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const draft: DraftUpsert = {
    id: b.id,
    threadId: str(b.threadId),
    inReplyTo: str(b.inReplyTo),
    to: str(b.to),
    subject: str(b.subject),
    bodyText: str(b.bodyText),
    bodyJson: str(b.bodyJson),
    fromLocal: str(b.fromLocal),
    fromDomain: str(b.fromDomain),
    fromName: str(b.fromName),
  };
  for (const key of Object.keys(DRAFT_LIMITS) as (keyof typeof DRAFT_LIMITS)[]) {
    if ((draft[key]?.length ?? 0) > DRAFT_LIMITS[key]) return { error: `draft '${key}' too large` };
  }
  // bodyJson must be a parseable TipTap document — anything else would break
  // the editor on resume (and there's no legitimate way to produce it).
  if (draft.bodyJson) {
    try {
      const doc = JSON.parse(draft.bodyJson) as { type?: unknown };
      if (!doc || typeof doc !== "object" || doc.type !== "doc") {
        return { error: "draft bodyJson is not an editor document" };
      }
    } catch {
      return { error: "draft bodyJson is not valid JSON" };
    }
  }
  return { draft };
}

export async function putDraft(env: { DB: D1Database }, d: DraftUpsert, now: number): Promise<void> {
  await ensureDraftsTable(env);
  await env.DB.prepare(
    `INSERT INTO drafts (id, thread_id, in_reply_to, msg_to, subject, body_text, body_json,
                         from_local, from_domain, from_name, updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       thread_id   = excluded.thread_id,
       in_reply_to = excluded.in_reply_to,
       msg_to      = excluded.msg_to,
       subject     = excluded.subject,
       body_text   = excluded.body_text,
       body_json   = excluded.body_json,
       from_local  = excluded.from_local,
       from_domain = excluded.from_domain,
       from_name   = excluded.from_name,
       updated     = excluded.updated`,
  )
    .bind(
      d.id,
      d.threadId ?? null,
      d.inReplyTo ?? null,
      d.to ?? null,
      d.subject ?? null,
      d.bodyText ?? null,
      d.bodyJson ?? null,
      d.fromLocal ?? null,
      d.fromDomain ?? null,
      d.fromName ?? null,
      now,
    )
    .run();
}

/** Newest-first draft summaries (snippet derived from the plain mirror). */
export async function listDrafts(env: { DB: D1Database }): Promise<
  Array<{
    id: string;
    threadId: string | null;
    to: string;
    subject: string;
    snippet: string;
    updated: number;
  }>
> {
  try {
    const r = await env.DB.prepare(
      `SELECT id, thread_id, msg_to, subject, body_text, updated
         FROM drafts ORDER BY updated DESC LIMIT 200`,
    ).all<DraftRow>();
    return (r.results ?? []).map((d) => ({
      id: d.id,
      threadId: d.thread_id,
      to: d.msg_to ?? "",
      subject: d.subject ?? "",
      snippet: (d.body_text ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
      updated: d.updated,
    }));
  } catch {
    return []; // table missing (pre-migration, nothing autosaved yet)
  }
}

export async function getDraft(env: { DB: D1Database }, id: string): Promise<DraftRow | null> {
  try {
    const r = await env.DB.prepare(`SELECT * FROM drafts WHERE id = ?`).bind(id).first<DraftRow>();
    return r ?? null;
  } catch {
    return null;
  }
}

export async function deleteDraft(env: { DB: D1Database }, id: string): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM drafts WHERE id = ?`).bind(id).run();
  } catch {
    // table missing → nothing to delete; converged
  }
}

/** Best-effort draft count for the sidebar badge. */
export async function countDrafts(env: { DB: D1Database }): Promise<number> {
  try {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM drafts`).first<{ n: number }>();
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}
