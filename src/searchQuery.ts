// Search query language: free text plus Gmail-style operators.
//
//   cabin from:maya has:attachment after:2026-01-01 "wood stove"
//
// Free text goes to FTS5 (bm25-ranked, prefix-matched). Operators become SQL
// predicates over the `messages` row, because the FTS index folds from/to/cc
// into one `participants` column and cannot tell a sender from a recipient.
//
// Everything a user types is reduced to bound parameters or a fixed token
// grammar before it reaches SQL: nothing here interpolates user text.

/** Max free-text tokens, so the MATCH expression stays bounded. */
const MAX_TOKENS = 12;
/** Max LIKE fallbacks. Each is a scan of the index, so keep it small. */
const MAX_LIKE_TERMS = 4;
/** Max operator predicates honoured in one query. */
const MAX_PREDICATES = 12;
const DAY = 86_400_000;

// Scripts written without spaces between words. FTS5's unicode61 tokenizer
// treats an unbroken run as ONE token, so a word in the middle of a sentence is
// unreachable by prefix match. Those terms fall back to a substring scan.
const UNSEGMENTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export type SearchScope = "live" | "trash" | "spam" | "any";

export interface ParsedSearch {
  /** FTS5 MATCH expression for the free text, or null when there is none. */
  match: string | null;
  /** Substrings scanned for in the index (unsegmented scripts). */
  likeTerms: string[];
  /** FTS5 expressions a message must NOT match (`-word`, `-"a phrase"`). */
  notMatch: string[];
  /** SQL predicates over `messages m`, to be AND-joined. */
  where: string[];
  /** Bound parameters for `where`, in order. */
  binds: unknown[];
  /** `in:trash` and `in:spam` search those; everything else excludes both. */
  scope: SearchScope;
  /** True when the query has nothing usable (the caller returns no results). */
  empty: boolean;
}

/**
 * Case-insensitive "column contains this text", as SQL plus its bind.
 *
 * Deliberately not LIKE. D1 rejects a LIKE pattern longer than 50 bytes, which
 * an ordinary `from:` address or a short CJK phrase exceeds, and stock SQLite
 * (which the tests run on) allows 50,000, so a LIKE here passes every test and
 * fails in production. instr() has no such limit and needs no wildcard
 * escaping: the needle is only ever compared literally.
 */
export function contains(column: string, text: string): { sql: string; bind: string } {
  return { sql: `instr(lower(COALESCE(${column},'')), ?) > 0`, bind: text.toLowerCase() };
}

/**
 * Parse `YYYY-MM-DD` or `YYYY/MM/DD` as the start of that day where the user
 * is. `tzOffsetMin` is what `Date.prototype.getTimezoneOffset()` returns in
 * their browser (minutes to ADD to local time to get UTC; 0 when unknown), so
 * "before:2026-03-01" means before their midnight, not UTC's. Null when invalid.
 */
function parseDay(v: string, tzOffsetMin: number): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d) + tzOffsetMin * 60_000;
  return Number.isFinite(t) ? t : null;
}

/** Parse a relative age such as `7d`, `2w`, `3m`, `1y` into milliseconds. */
function parseAge(v: string): number | null {
  const m = /^(\d{1,4})([dwmy])$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { d: 1, w: 7, m: 30, y: 365 }[m[2].toLowerCase() as "d" | "w" | "m" | "y"];
  return n * unit * DAY;
}

/**
 * Turn one operator into a predicate. Returns null when the operator or its
 * value is not recognised, in which case the caller treats the text as words.
 */
function predicateFor(
  op: string,
  value: string,
  now: number,
  tzOffsetMin: number,
): { sql: string; binds: unknown[]; scope?: SearchScope } | null {
  const v = value.trim();
  if (!v) return null;
  const has = (column: string) => contains(column, v);
  switch (op) {
    case "from":
      return { sql: has("m.msg_from").sql, binds: [has("m.msg_from").bind] };
    case "to": {
      const to = has("m.msg_to");
      const cc = has("m.msg_cc");
      return { sql: `(${to.sql} OR ${cc.sql})`, binds: [to.bind, cc.bind] };
    }
    case "cc":
      return { sql: has("m.msg_cc").sql, binds: [has("m.msg_cc").bind] };
    case "subject":
      return { sql: has("m.subject").sql, binds: [has("m.subject").bind] };
    case "domain":
      return { sql: "m.domain = ?", binds: [v.toLowerCase()] };
    case "has":
      return /^attachments?$/i.test(v) ? { sql: "m.has_attachments = 1", binds: [] } : null;
    case "is":
      switch (v.toLowerCase()) {
        case "unread": return { sql: "m.unread = 1", binds: [] };
        case "read": return { sql: "m.unread = 0", binds: [] };
        case "starred": return { sql: "m.starred = 1", binds: [] };
        default: return null;
      }
    case "in":
      switch (v.toLowerCase()) {
        // The inbox as the Inbox view shows it: snoozed mail is not in it.
        case "inbox": return { sql: "(m.direction = 'in' AND m.state = 'inbox' AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?))", binds: [now] };
        case "snoozed": return { sql: "(m.state = 'inbox' AND m.snoozed_until > ?)", binds: [now] };
        case "sent": return { sql: "m.direction = 'out'", binds: [] };
        case "archive":
        case "archived": return { sql: "m.state = 'archived'", binds: [] };
        case "trash": return { sql: "m.state = 'trash'", binds: [], scope: "trash" };
        case "spam":
        case "junk": return { sql: "m.state = 'trash'", binds: [], scope: "spam" };
        // Live mail only, like the All Mail view.
        case "all": return { sql: "1 = 1", binds: [] };
        // Everything, trash and junk included.
        case "anywhere": return { sql: "1 = 1", binds: [], scope: "any" };
        default: return null;
      }
    case "before": {
      const t = parseDay(v, tzOffsetMin);
      return t === null ? null : { sql: "m.date < ?", binds: [t] };
    }
    case "after": {
      const t = parseDay(v, tzOffsetMin);
      return t === null ? null : { sql: "m.date >= ?", binds: [t] };
    }
    case "older_than": {
      const age = parseAge(v);
      return age === null ? null : { sql: "m.date < ?", binds: [now - age] };
    }
    case "newer_than": {
      const age = parseAge(v);
      return age === null ? null : { sql: "m.date >= ?", binds: [now - age] };
    }
    default:
      return null;
  }
}

/**
 * Parse a user query into free text (FTS + LIKE fallbacks) and predicates.
 * Unknown operators and malformed values are kept as ordinary words, so a
 * query like `re: invoice` or `10:30` still searches for what was typed.
 */
export function parseSearchQuery(q: string, now: number = Date.now(), tzOffsetMin = 0): ParsedSearch {
  const atoms: string[] = [];
  const notMatch: string[] = [];
  const likeTerms: string[] = [];
  const where: string[] = [];
  const binds: unknown[] = [];
  let scope: SearchScope = "live";
  let tokenCount = 0;

  /** `-word` / `-"a phrase"`: exclude messages that match it. */
  const addNegated = (text: string, phrase: boolean) => {
    const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TOKENS);
    if (!words.length || notMatch.length >= MAX_LIKE_TERMS) return;
    notMatch.push(phrase && words.length > 1 ? `"${words.join(" ")}"` : words.map((w) => `"${w}"*`).join(" "));
  };

  const addWords = (text: string, phrase: boolean) => {
    const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!words.length) return;
    // An unsegmented-script term cannot be prefix-matched reliably, so scan for
    // it as a substring instead. The whole chunk is kept so a phrase stays one.
    if (words.some((w) => UNSEGMENTED.test(w))) {
      if (likeTerms.length < MAX_LIKE_TERMS) likeTerms.push(phrase ? text.trim() : words.join(" "));
      return;
    }
    if (tokenCount >= MAX_TOKENS) return;
    const kept = words.slice(0, MAX_TOKENS - tokenCount);
    tokenCount += kept.length;
    // A quoted phrase must match in order; bare words are prefix-matched.
    if (phrase && kept.length > 1) atoms.push(`"${kept.join(" ")}"`);
    else for (const w of kept) atoms.push(`"${w}"*`);
  };

  // One pass over: [-]op:"quoted value" | [-]op:value | [-]"quoted phrase" | [-]word
  const re = /(-?)([A-Za-z_]+):(?:"([^"]*)"|(\S+))|(-?)"([^"]*)"|(\S+)/g;
  for (let m = re.exec(q); m; m = re.exec(q)) {
    if (m[2]) {
      const op = m[2].toLowerCase();
      const value = m[3] ?? m[4] ?? "";
      const p = where.length < MAX_PREDICATES ? predicateFor(op, value, now, tzOffsetMin) : null;
      if (p) {
        // `in:trash` cannot be negated into a scope, so a negated scope
        // operator stays a plain predicate over live mail.
        if (p.scope && !m[1]) scope = p.scope;
        where.push(m[1] ? `NOT (${p.sql})` : p.sql);
        binds.push(...p.binds);
        continue;
      }
      // Not an operator we know: search for the words as typed.
      addWords(`${m[2]} ${value}`, false);
      continue;
    }
    if (m[6] !== undefined) (m[5] ? addNegated : addWords)(m[6], true);
    else if (m[7]) {
      // A leading minus excludes; a bare "-" or a dash inside a word does not.
      if (/^-[\p{L}\p{N}]/u.test(m[7])) addNegated(m[7].slice(1), false);
      else addWords(m[7], false);
    }
  }

  const match = atoms.length ? atoms.join(" ") : null;
  return {
    match,
    likeTerms,
    notMatch,
    where,
    binds,
    scope,
    // Exclusions alone ("-word") are not a search: there is nothing to find.
    empty: !match && likeTerms.length === 0 && where.length === 0,
  };
}

/**
 * Build the thread-collapsed search statement for a parsed query.
 *
 * FTS5 gotcha: bm25() may ONLY be evaluated where the FTS table is the sole,
 * UNALIASED source with the MATCH in its WHERE, never aliased and never inside
 * an aggregate over a JOIN. So the per-message rank is computed in a
 * MATERIALIZED `ranked` CTE first (an inlined CTE would push bm25 back into the
 * join and fail), then aggregated per thread in `hits`.
 *
 * The outer SELECT rebuilds each thread's display row from its latest message
 * in scope, the same collapse the normal views use. Results are ordered by
 * relevance when there is free text, newest first otherwise.
 */
export function buildSearchSql(
  p: ParsedSearch,
  opts: { limit: number; offset?: number; domain?: string; domainIncludesNull?: boolean },
): { sql: string; binds: unknown[] } {
  // Junk is trash with a mark, so Trash and Junk split the trash state the
  // same way the two views do.
  const scopeOf = (alias: string) =>
    p.scope === "trash"
      ? `${alias}.state='trash' AND ${alias}.spam=0`
      : p.scope === "spam"
        ? `${alias}.state='trash' AND ${alias}.spam=1`
        : p.scope === "any"
          ? "1 = 1"
          : `${alias}.state!='trash'`;
  const scopeSql = scopeOf("m");
  const live = `x.thread_id=h.thread_id AND ${scopeOf("x")}`;
  // INDEXED BY for the same reason as the view list (store_views.ts).
  const latest = (f: string) => `(SELECT ${f} FROM messages x INDEXED BY idx_messages_thread WHERE ${live} ORDER BY x.date DESC LIMIT 1)`;
  const binds: unknown[] = [];

  let ranked = "";
  if (p.match) {
    ranked = `ranked AS MATERIALIZED (
      SELECT messages_fts.message_id AS message_id, bm25(messages_fts) AS rank
      FROM messages_fts
      WHERE messages_fts MATCH ?
    ),`;
    binds.push(p.match);
  }

  const conditions = [scopeSql, ...p.where];
  binds.push(...p.binds);
  for (const term of p.likeTerms) {
    const parts = ["subject", "participants", "body"].map((c) => contains(c, term));
    conditions.push(`m.id IN (SELECT message_id FROM messages_fts WHERE ${parts.map((x) => x.sql).join(" OR ")})`);
    binds.push(...parts.map((x) => x.bind));
  }
  for (const expr of p.notMatch) {
    conditions.push(`m.id NOT IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)`);
    binds.push(expr);
  }
  if (opts.domain) {
    conditions.push(opts.domainIncludesNull ? "(m.domain = ? OR m.domain IS NULL)" : "m.domain = ?");
    binds.push(opts.domain.toLowerCase());
  }

  const sql = `
    WITH ${ranked}
    hits AS (
      SELECT m.thread_id AS thread_id,
             ${p.match ? "MIN(ranked.rank)" : "0"} AS rank,
             MAX(m.date) AS hitDate
      FROM messages m
      ${p.match ? "JOIN ranked ON ranked.message_id = m.id" : ""}
      WHERE ${conditions.join(" AND ")}
      GROUP BY m.thread_id
    )
    SELECT
      h.thread_id AS thread_id,
      ${latest("id")} AS id,
      ${latest("msg_from")} AS msg_from,
      ${latest("msg_to")} AS msg_to,
      ${latest("subject")} AS subject,
      ${latest("snippet")} AS snippet,
      ${latest("category")} AS category,
      ${latest("domain")} AS domain,
      (SELECT MAX(date) FROM messages x WHERE ${live}) AS date,
      (SELECT COUNT(*) FROM messages x WHERE ${live}) AS count,
      (SELECT MAX(unread) FROM messages x WHERE ${live}) AS anyUnread,
      (SELECT MAX(has_attachments) FROM messages x WHERE ${live}) AS hasAttachments,
      (SELECT MAX(starred) FROM messages x WHERE ${live}) AS starred
    FROM hits h
    ORDER BY h.rank, h.hitDate DESC, h.thread_id DESC
    LIMIT ? OFFSET ?`;
  binds.push(opts.limit, opts.offset ?? 0);
  return { sql, binds };
}
