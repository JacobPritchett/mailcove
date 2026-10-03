// Inbox filters/rules engine. A filter matches an inbound message on one field
// (from/to/subject) with a simple operator (contains/equals) and applies one
// action (archive/trash/star/read). Applied best-effort at ingest — never
// blocks delivery, never throws into the mail path.

import { parseAddressList } from "./contacts";
import { mutateMessage } from "./store_mutations";

export const FILTER_FIELDS = ["from", "to", "subject"] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];
export const FILTER_OPS = ["contains", "equals"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const FILTER_ACTIONS = ["archive", "trash", "star", "read"] as const;
export type FilterAction = (typeof FILTER_ACTIONS)[number];

const FIELD_SET = new Set<string>(FILTER_FIELDS);
const OP_SET = new Set<string>(FILTER_OPS);
const ACTION_SET = new Set<string>(FILTER_ACTIONS);
export const isFilterField = (x: unknown): x is FilterField => typeof x === "string" && FIELD_SET.has(x);
export const isFilterOp = (x: unknown): x is FilterOp => typeof x === "string" && OP_SET.has(x);
export const isFilterAction = (x: unknown): x is FilterAction => typeof x === "string" && ACTION_SET.has(x);

/** Max rules we store / read — bounds per-email work and list size. */
export const MAX_FILTERS = 50;

export interface Filter {
  id: string;
  field: FilterField;
  op: FilterOp;
  value: string;
  action: FilterAction;
  enabled: 0 | 1;
  position: number;
}

/** The message fields a filter can match against. */
export interface MatchTarget { from: string; to: string; subject: string }

/**
 * The forms of a stored From a rule may be written against, lowercased:
 * the string as stored, the bare address, and the DECODED form (display name
 * unquoted and unescaped, then ` <addr>`).
 *
 * msg_from is a display serialization: a name with a comma or a quote in it is
 * stored as an RFC 5322 quoted-string. A rule is typed from what the user sees
 * (`Doe, John <a@x.com>`, `John "Johnny" Doe`), so matching only the stored
 * string would make it depend on a storage detail.
 */
function fromForms(stored: string): { stored: string; decoded: string; address: string } {
  const raw = stored.toLowerCase();
  const parsed = parseAddressList(stored);
  if (parsed.length !== 1) return { stored: raw, decoded: raw, address: "" };
  const { name, email } = parsed[0];
  return { stored: raw, decoded: (name ? `${name} <${email}>` : `<${email}>`).toLowerCase(), address: email };
}

/** Does `filter` match `target`? Case-insensitive; empty value never matches. */
export function matchFilter(filter: Pick<Filter, "field" | "op" | "value">, target: MatchTarget): boolean {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return false;
  if (filter.field === "from") {
    const f = fromForms(target.from || "");
    return filter.op === "equals"
      ? needle === f.decoded.trim() || needle === f.stored.trim() || needle === f.address
      : f.decoded.includes(needle) || f.stored.includes(needle);
  }
  const hay = (target[filter.field] || "").toLowerCase();
  return filter.op === "equals" ? hay.trim() === needle : hay.includes(needle);
}

interface RulesEnv { DB: D1Database; MAILSTORE: R2Bucket }

/** archive/trash file the message away (out of the inbox); star/read don't. */
const FILES_AWAY = new Set<FilterAction>(["archive", "trash"]);

export interface ApplyResult { applied: FilterAction[]; leftInbox: boolean }

/**
 * Apply all enabled, matching filters to a just-received MESSAGE (by internal
 * id), with the same state transitions as a manual archive/trash/star/read
 * (pre_trash_state, trashed_at, etc.).
 *
 * Deliberately not thread-wide. The thread a message lands in is decided by its
 * References header, which the sender controls: acting on the whole thread let
 * an out-of-office reply (or anyone who knew a Message-ID) trash or archive a
 * real conversation through a rule that only ever matched their own message.
 *
 * Returns which actions fired and whether THIS message left the inbox (so the
 * caller can suppress a new-mail push for auto-filed mail). Best-effort.
 */
export async function applyFilters(
  env: RulesEnv,
  messageId: string,
  target: MatchTarget,
  now: number,
): Promise<ApplyResult> {
  const applied: FilterAction[] = [];
  let leftInbox = false;
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, field, op, value, action, enabled, position FROM filters WHERE enabled=1 ORDER BY position ASC, created ASC LIMIT ?`,
    )
      .bind(MAX_FILTERS)
      .all<Filter>();
    for (const f of results ?? []) {
      if (!isFilterField(f.field) || !isFilterOp(f.op) || !isFilterAction(f.action)) continue;
      if (!matchFilter(f, target)) continue;
      // Once a rule has filed the message away, don't also apply a later move;
      // star/read can still stack.
      if (leftInbox && FILES_AWAY.has(f.action)) continue;
      try {
        await mutateMessage(env, messageId, f.action, now);
        applied.push(f.action);
        if (FILES_AWAY.has(f.action)) leftInbox = true;
      } catch (e) {
        console.error("filter action failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    }
  } catch (e) {
    console.error("applyFilters failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  return { applied, leftInbox };
}
