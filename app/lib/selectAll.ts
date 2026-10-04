// "Select all in this view": acting on every conversation of a view or a
// search, not only the rows that happen to be loaded.
//
// The ids are collected first, all of them, and only then is anything
// changed. The Worker's bulk route takes 200 ids a call and stays that way;
// what was missing was a cheap way to learn the ids (GET /api/messages/ids,
// 500 a page). Collecting first is what makes this the same action as any
// other bulk action: one fixed set of conversations, chosen at the moment the
// user pressed the button, with the same optimistic update, the same toast
// and the same Undo. Mail that arrives while it runs is not swept in, and a
// view that empties as it is archived cannot shift the pages under the walk.
import { listThreadIds, type ListThreadsArgs } from "@/lib/api";

/**
 * The most conversations one "select all" acts on. Twenty requests to collect
 * and fifty to change: bounded work for the browser and for the Worker. A
 * larger view is done in more than one go, and the user is told.
 */
export const SELECT_ALL_MAX = 10_000;

export interface ViewIds {
  ids: string[];
  /** The view held more than SELECT_ALL_MAX: these are the first of them. */
  capped: boolean;
}

type Fetcher = typeof listThreadIds;

/** Every thread id of a view (or search), in list order, up to the cap. */
export async function collectViewIds(
  args: Omit<ListThreadsArgs, "limit" | "cursor">,
  fetchPage: Fetcher = listThreadIds,
): Promise<ViewIds> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  // Bounded by pages as well as by ids: a server that kept answering with a
  // cursor and nothing new must not hold the browser in a loop.
  for (let page = 0; page < SELECT_ALL_MAX / 100; page++) {
    const res: { ids: string[]; nextCursor: string | null } = await fetchPage({ ...args, cursor });
    for (const id of res.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length === SELECT_ALL_MAX) {
        // More than the cap only if this page had more to give or another follows.
        return { ids, capped: !!res.nextCursor || id !== res.ids[res.ids.length - 1] };
      }
    }
    if (!res.nextCursor || res.ids.length === 0) return { ids, capped: false };
    cursor = res.nextCursor;
  }
  return { ids, capped: true };
}
