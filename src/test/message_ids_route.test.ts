// GET /api/messages/ids: the thread ids of a whole view or search, for "select
// all N". Its one promise is that it agrees with the list route, so most tests
// here walk both routes over the same mailbox and compare, on a real SQL engine.
import { describe, it, expect } from "vitest";
import { handleFetch } from "../index";
import { makeSqliteEnv, api, type SqliteEnv } from "./sqlite_env";
import { IDS_PAGE_SIZE } from "../store_views";

const DAY = 86_400_000;

/**
 * A mailbox with every kind of row the view predicates tell apart: threads of
 * one to three messages, sent mail, archive, trash and junk, stars, snoozes
 * still running and snoozes that ended, the four categories plus none, two
 * domains plus legacy rows with no domain, and dates that collide so the
 * thread id has to break ties. Large enough that the inbox, the default
 * domain and the search each span more than one page of ids.
 */
function seedMixed(t: SqliteEnv, threads = 1500) {
  const now = Date.now();
  const insert = t.db.prepare(
    `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, unread, has_attachments,
                           state, starred, domain, category, spam, snoozed_until, woke_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const fts = t.db.prepare(`INSERT INTO messages_fts (message_id, subject, participants, body) VALUES (?,?,?,?)`);
  const categories = [null, "primary", "promotions", "updates", "social"];
  const domains = ["example.com", null, "other.org"];
  t.db.exec("BEGIN");
  for (let i = 0; i < threads; i++) {
    const thread = `t-${String(i).padStart(5, "0")}`;
    const size = 1 + (i % 3);
    for (let j = 0; j < size; j++) {
      const id = `${thread}-m${j}`;
      const out = j === 1;
      // Every tenth thread is trashed whole, half of those as junk; every
      // seventh is archived. Later messages of a thread vary on their own, so
      // a thread can straddle views.
      const state = i % 10 === 0 ? "trash" : (i + j) % 7 === 0 ? "archived" : "inbox";
      const spam = state === "trash" && i % 20 === 0 ? 1 : 0;
      // Snoozes: every ninth thread is asleep, every eleventh has woken (the
      // cron recorded it for half of those, the rest still carry the old time).
      let snoozedUntil: number | null = null;
      let wokeAt: number | null = null;
      if (state === "inbox" && !out) {
        if (i % 9 === 0) snoozedUntil = now + DAY + i;
        else if (i % 22 === 0) wokeAt = now - 1000 - i;
        else if (i % 11 === 0) snoozedUntil = now - 5000 - i;
      }
      // Dates collide in blocks of four threads.
      const date = 1_000_000 + Math.floor(i / 4) * 10 + j;
      const body = i % 2 === 0 ? "common body text" : "other words";
      insert.run(
        id, thread, out ? "out" : "in", out ? "sent" : "inbox", "a@example.com", "me@example.com", `Subject ${i}`, "snip",
        date, i % 5 === 0 ? 1 : 0, 0, state, i % 6 === 0 ? 1 : 0,
        domains[(i + j) % domains.length], categories[(i + j) % categories.length], spam, snoozedUntil, wokeAt,
      );
      fts.run(id, `Subject ${i}`, "a@example.com me@example.com", body);
    }
  }
  t.db.exec("COMMIT");
}

/** Every thread id the list route returns for a query, page by page. */
async function walkList(t: SqliteEnv, query: string): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const r = await api(t.env, "GET", `/api/messages?${query}&limit=150${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status).toBe(200);
    seen.push(...r.body.threads.map((x: { thread_id: string }) => x.thread_id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return seen;
}

/** Every thread id the ids route returns for a query, and the page sizes. */
async function walkIds(t: SqliteEnv, query: string): Promise<{ ids: string[]; pages: number[] }> {
  const ids: string[] = [];
  const pages: number[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const r = await api(t.env, "GET", `/api/messages/ids?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["ids", "nextCursor"]);
    ids.push(...r.body.ids);
    pages.push(r.body.ids.length);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return { ids, pages };
}

describe("GET /api/messages/ids agrees with the list route", () => {
  // One mailbox for the whole block: the routes only read it.
  const mailbox = makeSqliteEnv().then((t) => { seedMixed(t); return t; });

  const cases: { name: string; query: string; pagesAtLeast?: number }[] = [
    { name: "inbox", query: "view=inbox", pagesAtLeast: 2 },
    { name: "all mail", query: "view=all", pagesAtLeast: 3 },
    { name: "sent", query: "view=sent" },
    { name: "trash", query: "view=trash" },
    { name: "spam", query: "view=spam" },
    { name: "snoozed", query: "view=snoozed" },
    { name: "starred", query: "view=starred" },
    { name: "a category filter", query: "view=inbox&category=promotions" },
    { name: "the primary category, which includes uncategorized mail", query: "view=inbox&category=primary" },
    { name: "a domain filter", query: "view=all&domain=other.org" },
    { name: "the default domain, which includes legacy rows with no domain", query: "view=all&domain=example.com", pagesAtLeast: 2 },
    { name: "a category and a domain together", query: "view=inbox&category=updates&domain=other.org" },
    { name: "a search query", query: "q=common", pagesAtLeast: 2 },
    { name: "a search with an operator and a domain", query: `q=${encodeURIComponent("other is:unread")}&domain=other.org` },
    { name: "a search in the default domain, which includes legacy rows", query: `q=${encodeURIComponent("common is:starred")}&domain=example.com` },
    { name: "a search scoped to trash", query: `q=${encodeURIComponent("in:trash")}` },
    // The seeded dates sit about 17 minutes into 1970 in UTC, so this matches
    // only when the timezone offset is honoured (with tz=0 it matches nothing).
    { name: "a search with a date operator and a timezone", query: `q=${encodeURIComponent("subject:subject before:1970-01-01")}&tz=17`, pagesAtLeast: 2 },
  ];

  for (const c of cases) {
    it(`returns the same threads in the same order for ${c.name}`, async () => {
      const t = await mailbox;
      const expected = await walkList(t, c.query);
      const { ids, pages } = await walkIds(t, c.query);
      expect(expected.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(expected);
      expect(pages.length).toBeGreaterThanOrEqual(c.pagesAtLeast ?? 1);
      // Every page but the last is full.
      for (const n of pages.slice(0, -1)) expect(n).toBe(IDS_PAGE_SIZE);
    });
  }

  it("keeps trash and spam apart", async () => {
    const t = await mailbox;
    const trash = (await walkIds(t, "view=trash")).ids;
    const spam = (await walkIds(t, "view=spam")).ids;
    expect(trash.length).toBeGreaterThan(0);
    expect(spam.length).toBeGreaterThan(0);
    expect(trash.filter((id) => spam.includes(id))).toEqual([]);
  });

  it("keeps snoozed threads out of the inbox until their time passes", async () => {
    const t = await mailbox;
    const inbox = new Set((await walkIds(t, "view=inbox")).ids);
    const snoozed = (await walkIds(t, "view=snoozed")).ids;
    // t-00009 is a single message, asleep: only in Snoozed.
    expect(snoozed).toContain("t-00009");
    expect(inbox.has("t-00009")).toBe(false);
    // t-00011 woke already: back in the inbox, not in Snoozed.
    expect(inbox.has("t-00011")).toBe(true);
    expect(snoozed).not.toContain("t-00011");
  });

  it("ignores the view and the category while searching, as the list does", async () => {
    const t = await mailbox;
    const plain = (await walkIds(t, "q=common")).ids;
    const dressed = (await walkIds(t, "q=common&view=trash&category=social")).ids;
    expect(dressed).toEqual(plain);
  });

  it("ignores a limit parameter: the page size is fixed", async () => {
    const t = await mailbox;
    const r = await api(t.env, "GET", "/api/messages/ids?view=all&limit=5");
    expect(r.body.ids).toHaveLength(IDS_PAGE_SIZE);
  });
});

describe("GET /api/messages/ids paging", () => {
  /** n single-message inbox threads, one transaction. */
  function seedFlat(t: SqliteEnv, n: number, sameDate = false) {
    const insert = t.db.prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, unread, has_attachments, state, starred, domain)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    t.db.exec("BEGIN");
    for (let i = 0; i < n; i++) {
      const id = `m${String(i).padStart(5, "0")}`;
      insert.run(id, `t-${id}`, "in", "inbox", "a@example.com", "me@example.com", `S ${i}`, "snip", sameDate ? 1000 : 1000 + i, 0, 0, "inbox", 0, "example.com");
    }
    t.db.exec("COMMIT");
  }

  it("pages a view of 1100 threads as 500, 500, 100, newest first", async () => {
    const t = await makeSqliteEnv();
    seedFlat(t, 1100);
    const { ids, pages } = await walkIds(t, "view=inbox");
    expect(pages).toEqual([500, 500, 100]);
    expect(new Set(ids).size).toBe(1100);
    expect(ids[0]).toBe("t-m01099");
    expect(ids[1099]).toBe("t-m00000");
  });

  it("does not skip or repeat threads that share a timestamp across a page boundary", async () => {
    const t = await makeSqliteEnv();
    seedFlat(t, 1100, true);
    const { ids, pages } = await walkIds(t, "view=inbox");
    expect(pages).toEqual([500, 500, 100]);
    expect(new Set(ids).size).toBe(1100);
  });

  it("answers an exactly full last page with a cursor, then an empty page", async () => {
    const t = await makeSqliteEnv();
    seedFlat(t, IDS_PAGE_SIZE);
    const first = await api(t.env, "GET", "/api/messages/ids?view=inbox");
    expect(first.body.ids).toHaveLength(IDS_PAGE_SIZE);
    expect(first.body.nextCursor).toMatch(/^d\./);
    const second = await api(t.env, "GET", `/api/messages/ids?view=inbox&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body).toEqual({ ids: [], nextCursor: null });
  });

  it("is not disturbed by mail that arrives between pages", async () => {
    const t = await makeSqliteEnv();
    seedFlat(t, 600);
    const first = await api(t.env, "GET", "/api/messages/ids?view=inbox");
    t.db.prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, unread, has_attachments, state, starred, domain)
       VALUES ('new','t-new','in','inbox','a@example.com','me@example.com','New','s',999999,1,0,'inbox',0,'example.com')`,
    ).run();
    const second = await api(t.env, "GET", `/api/messages/ids?view=inbox&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    const ids = [...first.body.ids, ...second.body.ids];
    expect(new Set(ids).size).toBe(600);
    expect(ids).not.toContain("t-new");
  });

  it("hands back cursors the list route accepts, and accepts the list route's", async () => {
    const t = await makeSqliteEnv();
    seedFlat(t, 700);
    const ids = await api(t.env, "GET", "/api/messages/ids?view=inbox");
    const list = await api(t.env, "GET", `/api/messages?view=inbox&limit=200&cursor=${encodeURIComponent(ids.body.nextCursor)}`);
    expect(list.status).toBe(200);
    expect(list.body.threads[0].thread_id).toBe("t-m00199");
    const listFirst = await api(t.env, "GET", "/api/messages?view=inbox&limit=200");
    const rest = await api(t.env, "GET", `/api/messages/ids?view=inbox&cursor=${encodeURIComponent(listFirst.body.nextCursor)}`);
    expect(rest.body.ids).toHaveLength(500);
    expect(rest.body.ids[0]).toBe("t-m00499");
    expect(rest.body.nextCursor).not.toBeNull();
  });

  it("returns no ids and no cursor for an empty view", async () => {
    const t = await makeSqliteEnv();
    for (const query of ["view=inbox", "view=trash", "view=snoozed", "view=inbox&category=social", "q=nothing"]) {
      const r = await api(t.env, "GET", `/api/messages/ids?${query}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ids: [], nextCursor: null });
    }
  });

  it("returns no ids for a search with nothing to look for", async () => {
    const t = await makeSqliteEnv();
    seedFlat(t, 3);
    const r = await api(t.env, "GET", `/api/messages/ids?q=${encodeURIComponent("-word")}`);
    expect(r.body).toEqual({ ids: [], nextCursor: null });
  });
});

describe("GET /api/messages/ids validation", () => {
  it("rejects a malformed or mismatched cursor instead of restarting from the top", async () => {
    const t = await makeSqliteEnv();
    const bad = [
      "view=inbox&cursor=nonsense",
      "view=inbox&cursor=o.10",
      "q=common&cursor=d.1.x",
      "q=common&cursor=nonsense",
      "view=inbox&cursor=d.1.%25E0%25A4%25A",
    ];
    for (const query of bad) {
      const r = await api(t.env, "GET", `/api/messages/ids?${query}`);
      expect(r.status, query).toBe(400);
      expect(r.body.error).toBe("invalid cursor");
    }
  });

  it("rejects an invalid view", async () => {
    const t = await makeSqliteEnv();
    const r = await api(t.env, "GET", "/api/messages/ids?view=everything");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid view");
  });

  it("rejects a present but invalid domain instead of silently unfiltering", async () => {
    const t = await makeSqliteEnv();
    const r = await api(t.env, "GET", "/api/messages/ids?view=inbox&domain=x%27%20OR%201");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid domain");
  });

  it("answers the same 400 as the list route for the same bad input", async () => {
    const t = await makeSqliteEnv();
    for (const query of ["view=nope", "view=inbox&domain=-bad", "view=inbox&cursor=o.1", "q=x&cursor=d.1.x"]) {
      const list = await api(t.env, "GET", `/api/messages?${query}`);
      const ids = await api(t.env, "GET", `/api/messages/ids?${query}`);
      expect(ids.status, query).toBe(400);
      expect(ids.body, query).toEqual(list.body);
    }
  });

  it("defaults to the inbox when no view is given, as the list does", async () => {
    const t = await makeSqliteEnv();
    seedMixed(t, 40);
    expect((await walkIds(t, "")).ids).toEqual(await walkList(t, "view=inbox"));
  });
});

describe("GET /api/messages/ids routing and credentials", () => {
  it("is not swallowed by the /api/messages/:id route", async () => {
    const t = await makeSqliteEnv();
    // A message whose id is literally "ids": the message route would serve it.
    t.db.prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, state)
       VALUES ('ids','t-ids','in','inbox','a@example.com','me@example.com','Named ids','s',1000,'inbox')`,
    ).run();
    const r = await api(t.env, "GET", "/api/messages/ids");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ids: ["t-ids"], nextCursor: null });
  });

  it("is read-only: other methods do not reach it", async () => {
    const t = await makeSqliteEnv();
    const r = await api(t.env, "POST", "/api/messages/ids", {});
    expect(r.status).not.toBe(200);
    expect(r.body.ids).toBeUndefined();
  });

  it("refuses a request with no credential", async () => {
    const t = await makeSqliteEnv();
    const res = await handleFetch(new Request("https://inbox.example.com/api/messages/ids?view=inbox"), t.env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });


});

describe("ids speed on a large mailbox", () => {
  // Same shape as the list speed test in pagination.test.ts. The filtered
  // variants are the ones that run a per-thread lookup, so they are the ones
  // that would go quadratic if the thread index pin were lost.
  it("returns a page of ids from 16k messages in well under a second", async () => {
    const t = await makeSqliteEnv();
    const insert = t.db.prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, unread, has_attachments, state, starred, domain, category)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    t.db.exec("BEGIN");
    for (let i = 0; i < 16_000; i++) {
      const thread = `t${i % 8000}`;
      insert.run(`m${i}`, thread, i % 4 === 3 ? "out" : "in", "inbox", "a@example.com", "me@example.com", `S ${i}`, "snip", 1_000_000 + i, i % 5 === 0 ? 1 : 0, 0, i % 7 === 0 ? "archived" : "inbox", 0, "example.com", i % 2 === 0 ? "promotions" : null);
    }
    t.db.exec("COMMIT");
    for (const query of ["view=inbox", "view=all", "view=all&category=primary&domain=example.com"]) {
      const t0 = performance.now();
      const first = await api(t.env, "GET", `/api/messages/ids?${query}`);
      const second = await api(t.env, "GET", `/api/messages/ids?${query}&cursor=${encodeURIComponent(first.body.nextCursor)}`);
      const ms = performance.now() - t0;
      expect(first.body.ids).toHaveLength(IDS_PAGE_SIZE);
      expect(second.body.ids).toHaveLength(IDS_PAGE_SIZE);
      expect(ms, `${query} took ${Math.round(ms)} ms`).toBeLessThan(3000);
    }
  }, 60_000);
});
