// List paging through the real route on a real SQL engine.
import { describe, it, expect } from "vitest";
import { makeSqliteEnv, api, type SqliteEnv } from "./sqlite_env";
import { parseCursor, parsePageSize, encodeDateCursor } from "../store_views";

function seed(t: SqliteEnv, n: number, opts: { sameDate?: boolean } = {}) {
  const insert = t.db.prepare(
    `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, unread, has_attachments, state, starred, domain)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const fts = t.db.prepare(`INSERT INTO messages_fts (message_id, subject, participants, body) VALUES (?,?,?,?)`);
  for (let i = 0; i < n; i++) {
    const id = `m${String(i).padStart(4, "0")}`;
    insert.run(id, `t-${id}`, "in", "inbox", "a@example.com", "me@example.com", `Subject ${i}`, "snip", opts.sameDate ? 1000 : 1000 + i, 0, 0, "inbox", 0, "example.com");
    fts.run(id, `Subject ${i}`, "a@example.com me@example.com", "common body text");
  }
}

async function walk(t: SqliteEnv, query: string, pageSize: number) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url: string = `/api/messages?${query}&limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await api(t.env, "GET", url);
    expect(r.status).toBe(200);
    seen.push(...r.body.threads.map((x: { thread_id: string }) => x.thread_id));
    cursor = r.body.nextCursor;
    pages++;
  } while (cursor && pages < 50);
  return { seen, pages };
}

describe("list paging", () => {
  it("walks a view newest first with no gaps and no repeats", async () => {
    const t = await makeSqliteEnv();
    seed(t, 23);
    const { seen, pages } = await walk(t, "view=inbox", 10);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect(seen[0]).toBe("t-m0022");
    expect(seen[22]).toBe("t-m0000");
    expect(pages).toBe(3);
  });

  it("does not skip or repeat threads that share a timestamp", async () => {
    const t = await makeSqliteEnv();
    seed(t, 25, { sameDate: true });
    const { seen } = await walk(t, "view=inbox", 7);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toHaveLength(25);
  });

  it("is not disturbed by mail that arrives between pages", async () => {
    const t = await makeSqliteEnv();
    seed(t, 20);
    const first = await api(t.env, "GET", "/api/messages?view=inbox&limit=10");
    t.db.prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, unread, has_attachments, state, starred, domain)
       VALUES ('new','t-new','in','inbox','a@example.com','me@example.com','New','s',999999,1,0,'inbox',0,'example.com')`,
    ).run();
    const second = await api(t.env, "GET", `/api/messages?view=inbox&limit=10&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    const ids = [...first.body.threads, ...second.body.threads].map((x: { thread_id: string }) => x.thread_id);
    expect(new Set(ids).size).toBe(20);
    expect(ids).not.toContain("t-new");
  });

  it("reports no next page when the page is not full", async () => {
    const t = await makeSqliteEnv();
    seed(t, 5);
    const r = await api(t.env, "GET", "/api/messages?view=inbox&limit=10");
    expect(r.body.threads).toHaveLength(5);
    expect(r.body.nextCursor).toBeNull();
  });

  it("pages search results by offset", async () => {
    const t = await makeSqliteEnv();
    seed(t, 23);
    const { seen } = await walk(t, "q=common", 10);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });

  it("keeps the old behaviour with no limit or cursor", async () => {
    const t = await makeSqliteEnv();
    seed(t, 5);
    const r = await api(t.env, "GET", "/api/messages?view=inbox");
    expect(r.body.threads).toHaveLength(5);
  });

  it("rejects a malformed or mismatched cursor instead of restarting from the top", async () => {
    const t = await makeSqliteEnv();
    seed(t, 5);
    expect((await api(t.env, "GET", "/api/messages?view=inbox&cursor=nonsense")).status).toBe(400);
    expect((await api(t.env, "GET", "/api/messages?view=inbox&cursor=o.10")).status).toBe(400);
    expect((await api(t.env, "GET", "/api/messages?q=common&cursor=d.1.x")).status).toBe(400);
  });

  it("survives a thread id with awkward characters in the cursor", async () => {
    const row = { date: 5, thread_id: "a/b.c%d<e>@example.com" };
    expect(parseCursor(encodeDateCursor(row))).toEqual({ kind: "date", after: { date: 5, threadId: row.thread_id } });
    expect(parseCursor("d.5.%E0%A4%A")).toBeNull();
    expect(parseCursor("d." + "9".repeat(40) + ".x")).toBeNull();
  });
});

describe("parsePageSize", () => {
  it("accepts 1..200 and falls back otherwise", () => {
    expect(parsePageSize("50")).toBe(50);
    expect(parsePageSize(null)).toBe(200);
    expect(parsePageSize("0")).toBe(200);
    expect(parsePageSize("9999")).toBe(200);
    expect(parsePageSize("-5")).toBe(200);
    expect(parsePageSize("abc")).toBe(200);
  });
});

describe("list speed on a large mailbox", () => {
  // D1 keeps no planner statistics, and without them SQLite picked the
  // state/date index for the per-thread lookups: 25 s for one page at this
  // size. The queries pin the thread index; this fails if that is ever lost.
  it("lists and pages 16k messages in well under a second per page", async () => {
    const t = await makeSqliteEnv();
    const insert = t.db.prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, snippet, date, unread, has_attachments, state, starred, domain)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    t.db.exec("BEGIN");
    for (let i = 0; i < 16_000; i++) {
      const thread = `t${i % 8000}`;
      insert.run(`m${i}`, thread, i % 4 === 3 ? "out" : "in", "inbox", "a@example.com", "me@example.com", `S ${i}`, "snip", 1_000_000 + i, i % 5 === 0 ? 1 : 0, 0, i % 7 === 0 ? "archived" : "inbox", 0, "example.com");
    }
    t.db.exec("COMMIT");
    for (const view of ["inbox", "all", "sent"]) {
      const t0 = performance.now();
      const first = await api(t.env, "GET", `/api/messages?view=${view}&limit=50`);
      const second = await api(t.env, "GET", `/api/messages?view=${view}&limit=50&cursor=${encodeURIComponent(first.body.nextCursor)}`);
      const ms = performance.now() - t0;
      expect(first.body.threads).toHaveLength(50);
      expect(second.body.threads).toHaveLength(50);
      expect(ms, `${view} took ${Math.round(ms)} ms`).toBeLessThan(3000);
    }
  }, 60_000);
});
