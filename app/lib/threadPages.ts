// How the paged thread list is kept in one flat cache entry.
//
// The list loads 50 rows at a time. Polling must not refetch every page the
// user has scrolled through, so only the FIRST page is ever refreshed and the
// result is merged into whatever is already loaded. These are the pure rules
// for that merge and for appending a later page; lib/queries.ts wires them to
// TanStack Query.

import type { ThreadListRow, ThreadsResponse } from "./types";

/** Rows per request. The Worker allows up to 200; 50 fills several screens. */
export const THREADS_PAGE_SIZE = 50;

/**
 * The cached list: every page loaded so far, flattened, plus the cursor for
 * the next one. The two flags are client state about the "load more" request
 * and live here so every component reading the list sees the same thing.
 */
export interface ThreadListData extends ThreadsResponse {
  loadingMore?: boolean;
  moreFailed?: boolean;
}

/** The key the server orders a view by (see listThreadsByView). */
function sortKey(t: ThreadListRow): number {
  return t.sort_date ?? t.date;
}

/** Does `row` come strictly after `boundary` in the server's list order? */
function isAfter(row: ThreadListRow, boundary: ThreadListRow): boolean {
  const a = sortKey(row);
  const b = sortKey(boundary);
  return a < b || (a === b && row.thread_id < boundary.thread_id);
}

/**
 * Fold a freshly fetched first page into the loaded list.
 *
 * A view is ordered newest first, so the fresh page is the truth for
 * everything down to its last row: rows of ours in that range that it no
 * longer lists are gone, and rows it lists that we held further down (a thread
 * that just got a reply) have moved up. Everything below the last fresh row is
 * kept as it was, with the cursor that continues from it.
 *
 * Search is ordered by relevance, which has no such boundary, so there the
 * fresh page simply replaces the first page's worth of rows.
 */
export function mergeFirstPage(
  prev: ThreadListData | undefined,
  fresh: ThreadsResponse,
  searching: boolean,
): ThreadListData {
  const flags = { loadingMore: prev?.loadingMore, moreFailed: prev?.moreFailed };
  const whole: ThreadListData = { ...fresh, nextCursor: fresh.nextCursor ?? null, ...flags };
  // No further page on the server: the fresh page is the entire list.
  if (!prev || !fresh.nextCursor || fresh.threads.length === 0) return whole;

  const inFresh = new Set(fresh.threads.map((t) => t.thread_id));
  let tail: ThreadListRow[];
  if (searching) {
    tail = prev.threads.slice(fresh.threads.length).filter((t) => !inFresh.has(t.thread_id));
  } else {
    const boundary = fresh.threads[fresh.threads.length - 1];
    // Everything we hold sits below the fresh page: more than a page of new
    // mail arrived at once, and the rows between the two are unknown. Start
    // over from the top rather than show a list with a hole in it.
    if (prev.threads.length > 0 && isAfter(prev.threads[0], boundary) && !inFresh.has(prev.threads[0].thread_id)) {
      return whole;
    }
    tail = prev.threads.filter((t) => !inFresh.has(t.thread_id) && isAfter(t, boundary));
  }
  if (tail.length === 0) return whole;
  return {
    ...fresh,
    threads: [...fresh.threads, ...tail],
    // The kept rows end where the old list ended, so its cursor still applies
    // (null when the old list had already reached the end).
    nextCursor: prev.nextCursor ?? null,
    ...flags,
  };
}

/**
 * Append a later page. `cursor` is the one the page was fetched with: if the
 * list has moved on from it (reset by a refresh, rolled back by a failed
 * action) the page no longer continues what is on screen and is dropped.
 * Rows already listed are skipped, so a thread can never appear twice.
 */
export function appendPage(
  cur: ThreadListData,
  page: ThreadsResponse,
  cursor: string,
): { data: ThreadListData; added: ThreadListRow[] } {
  if (cur.nextCursor !== cursor) {
    return { data: { ...cur, loadingMore: false }, added: [] };
  }
  const have = new Set(cur.threads.map((t) => t.thread_id));
  const added = page.threads.filter((t) => !have.has(t.thread_id));
  return {
    data: {
      ...cur,
      threads: [...cur.threads, ...added],
      nextCursor: page.nextCursor ?? null,
      loadingMore: false,
      moreFailed: false,
    },
    added,
  };
}

/**
 * Put back a row an action removed (undo). A view is ordered, so the row goes
 * where its date says; search has no such order, so it returns to the position
 * it was taken from. A row that is already listed is left alone.
 */
export function reinsertRow(
  rows: ThreadListRow[],
  row: ThreadListRow,
  index: number,
  searching: boolean,
): ThreadListRow[] {
  if (rows.some((t) => t.thread_id === row.thread_id)) return rows;
  let at = Math.min(index, rows.length);
  if (!searching) {
    at = rows.findIndex((t) => isAfter(t, row));
    if (at === -1) at = rows.length;
  }
  return [...rows.slice(0, at), row, ...rows.slice(at)];
}
