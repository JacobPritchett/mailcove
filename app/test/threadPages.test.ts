import { describe, it, expect } from "vitest";
import { appendPage, mergeFirstPage, reinsertRow, type ThreadListData } from "@/lib/threadPages";
import type { ThreadListRow, ThreadsResponse } from "@/lib/types";

/** A row whose position in a view is its date (newest first). */
function row(id: string, date: number, extra: Partial<ThreadListRow> = {}): ThreadListRow {
  return {
    thread_id: id, id: `m-${id}`, msg_from: "a@example.com", msg_to: "me@example.com",
    subject: id, snippet: "", date, sort_date: date, count: 1, anyUnread: 0,
    hasAttachments: 0, starred: 0, category: null, ...extra,
  };
}
const resp = (threads: ThreadListRow[], nextCursor: string | null): ThreadsResponse => ({
  threads, unread: 0, user: "me", nextCursor,
});
const ids = (d: { threads: ThreadListRow[] }) => d.threads.map((t) => t.thread_id);

describe("mergeFirstPage (a view, newest first)", () => {
  it("is the fresh page when nothing is loaded yet", () => {
    const out = mergeFirstPage(undefined, resp([row("a", 30), row("b", 20)], "c1"), false);
    expect(ids(out)).toEqual(["a", "b"]);
    expect(out.nextCursor).toBe("c1");
  });

  it("is the fresh page when the server has no further page", () => {
    const prev: ThreadListData = resp([row("a", 30), row("b", 20), row("c", 10)], null);
    const out = mergeFirstPage(prev, resp([row("a", 30), row("c", 10)], null), false);
    expect(ids(out)).toEqual(["a", "c"]);
    expect(out.nextCursor).toBeNull();
  });

  it("keeps the later pages and their cursor under a refreshed first page", () => {
    const prev: ThreadListData = resp([row("a", 50), row("b", 40), row("c", 30), row("d", 20)], "after-d");
    const out = mergeFirstPage(prev, resp([row("a", 50), row("b", 40)], "after-b"), false);
    expect(ids(out)).toEqual(["a", "b", "c", "d"]);
    expect(out.nextCursor).toBe("after-d");
  });

  it("puts new mail on top and pushes the displaced row into the kept tail", () => {
    const prev: ThreadListData = resp([row("a", 50), row("b", 40)], "after-b");
    const out = mergeFirstPage(prev, resp([row("new", 60), row("a", 50)], "after-a"), false);
    expect(ids(out)).toEqual(["new", "a", "b"]);
    // b is still the last row we hold, so the next page continues after it.
    expect(out.nextCursor).toBe("after-b");
  });

  it("moves a thread that got a reply to the top without listing it twice", () => {
    const prev: ThreadListData = resp([row("a", 50), row("b", 40), row("c", 30), row("d", 20)], "after-d");
    const out = mergeFirstPage(prev, resp([row("d", 60), row("a", 50)], "after-a"), false);
    expect(ids(out)).toEqual(["d", "a", "b", "c"]);
  });

  it("drops a row the fresh page no longer lists within its range", () => {
    const prev: ThreadListData = resp([row("a", 50), row("b", 40), row("c", 30), row("d", 20)], "after-d");
    // b was archived elsewhere; the page now reaches down to c.
    const out = mergeFirstPage(prev, resp([row("a", 50), row("c", 30)], "after-c"), false);
    expect(ids(out)).toEqual(["a", "c", "d"]);
    expect(out.nextCursor).toBe("after-d");
  });

  it("keeps a reached end reached", () => {
    const prev: ThreadListData = resp([row("a", 50), row("b", 40), row("c", 30)], null);
    const out = mergeFirstPage(prev, resp([row("a", 50), row("b", 40)], "after-b"), false);
    expect(ids(out)).toEqual(["a", "b", "c"]);
    expect(out.nextCursor).toBeNull();
  });

  it("starts over when a whole page of new mail leaves a gap above what is loaded", () => {
    const prev: ThreadListData = resp([row("a", 50), row("b", 40)], "after-b");
    const out = mergeFirstPage(prev, resp([row("n1", 90), row("n2", 80)], "after-n2"), false);
    expect(ids(out)).toEqual(["n1", "n2"]);
    expect(out.nextCursor).toBe("after-n2");
  });

  it("orders rows sharing a millisecond by thread id, as the server does", () => {
    const prev: ThreadListData = resp([row("c", 10), row("b", 10), row("a", 10)], "after-a");
    const out = mergeFirstPage(prev, resp([row("c", 10), row("b", 10)], "after-b"), false);
    expect(ids(out)).toEqual(["c", "b", "a"]);
  });

  it("sorts a woken thread by sort_date, not its message date", () => {
    const woken = row("w", 5, { sort_date: 60 });
    const prev: ThreadListData = resp([row("a", 50), row("b", 40)], "after-b");
    const out = mergeFirstPage(prev, resp([woken, row("a", 50)], "after-a"), false);
    expect(ids(out)).toEqual(["w", "a", "b"]);
  });

  it("carries the load-more flags across a refresh", () => {
    const prev: ThreadListData = { ...resp([row("a", 50), row("b", 40)], "after-b"), loadingMore: true };
    expect(mergeFirstPage(prev, resp([row("a", 50)], "after-a"), false).loadingMore).toBe(true);
  });
});

describe("mergeFirstPage (search, by relevance)", () => {
  it("replaces the first page's worth of rows and keeps the rest", () => {
    const prev: ThreadListData = resp([row("a", 1), row("b", 9), row("c", 5), row("d", 7)], "o.4");
    const out = mergeFirstPage(prev, resp([row("x", 3), row("c", 5)], "o.2"), true);
    expect(ids(out)).toEqual(["x", "c", "d"]);
    expect(out.nextCursor).toBe("o.4");
  });
});

describe("appendPage", () => {
  it("appends the page and takes its cursor", () => {
    const cur: ThreadListData = { ...resp([row("a", 50)], "c1"), loadingMore: true };
    const { data, added } = appendPage(cur, resp([row("b", 40)], "c2"), "c1");
    expect(ids(data)).toEqual(["a", "b"]);
    expect(data.nextCursor).toBe("c2");
    expect(data.loadingMore).toBe(false);
    expect(added.map((t) => t.thread_id)).toEqual(["b"]);
  });

  it("never lists a thread twice", () => {
    const cur: ThreadListData = resp([row("a", 50), row("b", 40)], "c1");
    const { data, added } = appendPage(cur, resp([row("b", 40), row("c", 30)], null), "c1");
    expect(ids(data)).toEqual(["a", "b", "c"]);
    expect(added.map((t) => t.thread_id)).toEqual(["c"]);
    expect(data.nextCursor).toBeNull();
  });

  it("drops a page fetched for a cursor the list has moved on from", () => {
    const cur: ThreadListData = { ...resp([row("n", 90)], "fresh"), loadingMore: true };
    const { data, added } = appendPage(cur, resp([row("z", 1)], "c9"), "stale");
    expect(ids(data)).toEqual(["n"]);
    expect(data.nextCursor).toBe("fresh");
    expect(data.loadingMore).toBe(false);
    expect(added).toEqual([]);
  });
});

describe("reinsertRow", () => {
  it("returns a row to its place by date in a view", () => {
    const rows = [row("a", 50), row("c", 30)];
    expect(reinsertRow(rows, row("b", 40), 0, false).map((t) => t.thread_id)).toEqual(["a", "b", "c"]);
    expect(reinsertRow(rows, row("z", 1), 0, false).map((t) => t.thread_id)).toEqual(["a", "c", "z"]);
  });

  it("returns a row to the position it was taken from in search results", () => {
    const rows = [row("a", 1), row("c", 9)];
    expect(reinsertRow(rows, row("b", 5), 1, true).map((t) => t.thread_id)).toEqual(["a", "b", "c"]);
    expect(reinsertRow(rows, row("b", 5), 99, true).map((t) => t.thread_id)).toEqual(["a", "c", "b"]);
  });

  it("leaves a list that already holds the row untouched", () => {
    const rows = [row("a", 50), row("b", 40)];
    expect(reinsertRow(rows, row("b", 40), 0, false)).toBe(rows);
  });
});
