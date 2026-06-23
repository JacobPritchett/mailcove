import { describe, it, expect, vi } from "vitest";
import {
  toFtsMatch,
  bodyForIndex,
  ftsRowFrom,
  ftsUpsert,
  ftsDelete,
  searchThreads,
  reindexAll,
} from "../search";

// A DB mock that records every prepared SQL + bound params and lets a test
// control what `.all()` / `.run()` return (or throw).
function makeDb(opts: { allResults?: unknown[]; throwOn?: RegExp } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] };
      calls.push(call);
      const maybeThrow = () => {
        if (opts.throwOn && opts.throwOn.test(sql)) throw new Error("d1 boom");
      };
      const exec = {
        run: async () => { maybeThrow(); return {}; },
        all: async () => { maybeThrow(); return { results: opts.allResults ?? [] }; },
        first: async () => { maybeThrow(); return null; },
      };
      // Support both `.bind(...).run()` and bare `.run()` / `.all()`.
      return { bind: (...params: unknown[]) => { call.params = params; return exec; }, ...exec };
    },
  };
  return { db: db as any, calls };
}

describe("toFtsMatch", () => {
  it("emits quoted prefix tokens AND-joined", () => {
    expect(toFtsMatch("spice shipment")).toBe('"spice"* "shipment"*');
  });
  it("returns null when there are no alphanumeric tokens", () => {
    expect(toFtsMatch("   ")).toBeNull();
    expect(toFtsMatch("...,;:!")).toBeNull();
    expect(toFtsMatch("")).toBeNull();
  });
  it("strips FTS operators/punctuation so user input can't inject syntax", () => {
    // No raw quotes, colons, parens, NEAR/OR operators survive — only "tok"* atoms.
    const m = toFtsMatch('subject:(foo OR bar) "baz" -qux');
    expect(m).toBe('"subject"* "foo"* "OR"* "bar"* "baz"* "qux"*');
    expect(m).not.toMatch(/[():\-]/);
  });
  it("handles unicode word characters", () => {
    expect(toFtsMatch("café déjà")).toBe('"café"* "déjà"*');
  });
  it("caps the number of tokens", () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`).join(" ");
    const m = toFtsMatch(many)!;
    expect(m.split(" ").length).toBe(12);
  });
});

describe("bodyForIndex", () => {
  it("prefers plain text and collapses whitespace", () => {
    expect(bodyForIndex("hello   world\n\nthere", "<p>ignored</p>")).toBe("hello world there");
  });
  it("falls back to HTML with tags stripped when text is empty", () => {
    expect(bodyForIndex("", "<p>Hi <b>there</b></p>")).toBe("Hi there");
  });
  it("returns '' for empty input", () => {
    expect(bodyForIndex("", "")).toBe("");
  });
});

describe("ftsRowFrom", () => {
  it("joins non-empty participants and passes body through", () => {
    const r = ftsRowFrom({ id: "m1", subject: "Hi", from: "a@x.com", to: "b@y.com", cc: "", bodyText: "hello" });
    expect(r).toEqual({
      message_id: "m1",
      subject: "Hi",
      participants: "a@x.com b@y.com",
      body: "hello",
    });
  });
});

describe("ftsUpsert", () => {
  it("deletes then inserts with the row's fields", async () => {
    const { db, calls } = makeDb();
    const ok = await ftsUpsert({ DB: db }, ftsRowFrom({ id: "m1", subject: "S", from: "a@x.com", to: "b@y.com", bodyText: "body" }));
    expect(ok).toBe(true);
    expect(calls[0].sql).toMatch(/DELETE FROM messages_fts/i);
    expect(calls[0].params).toEqual(["m1"]);
    expect(calls[1].sql).toMatch(/INSERT INTO messages_fts/i);
    expect(calls[1].params).toEqual(["m1", "S", "a@x.com b@y.com", "body"]);
  });
  it("is best-effort: swallows DB errors and returns false (never breaks mail flow)", async () => {
    const { db } = makeDb({ throwOn: /messages_fts/ });
    const ok = await ftsUpsert({ DB: db }, ftsRowFrom({ id: "m1", subject: "", from: "", to: "", bodyText: "" }));
    expect(ok).toBe(false);
  });
});

describe("ftsDelete", () => {
  it("issues one delete per id and swallows errors", async () => {
    const { db, calls } = makeDb();
    await ftsDelete({ DB: db }, ["m1", "m2"]);
    expect(calls.map((c) => c.params[0])).toEqual(["m1", "m2"]);
    expect(calls.every((c) => /DELETE FROM messages_fts/i.test(c.sql))).toBe(true);
  });
  it("does not throw when D1 errors", async () => {
    const { db } = makeDb({ throwOn: /messages_fts/ });
    await expect(ftsDelete({ DB: db }, ["m1"])).resolves.toBeUndefined();
  });
});

describe("searchThreads", () => {
  it("returns [] without touching the DB when the query has no usable tokens", async () => {
    const { db, calls } = makeDb();
    expect(await searchThreads({ DB: db }, "   ")).toEqual([]);
    expect(calls.length).toBe(0);
  });
  it("runs an FTS MATCH + bm25-ranked, trash-excluded, thread-collapsed query", async () => {
    const rows = [{ thread_id: "t1", id: "m1", subject: "Spice", snippet: "...", date: 1, count: 1, anyUnread: 1, hasAttachments: 0, starred: 0, msg_from: "a", msg_to: "b" }];
    const { db, calls } = makeDb({ allResults: rows });
    const out = await searchThreads({ DB: db }, "spice", 50);
    expect(out).toEqual(rows);
    const { sql, params } = calls[0];
    expect(sql).toMatch(/messages_fts MATCH/i);
    expect(sql).toMatch(/bm25\(messages_fts\)/i);
    expect(sql).toMatch(/state\s*!=\s*'trash'/i);
    expect(sql).toMatch(/GROUP BY m\.thread_id/i);
    expect(sql).toMatch(/ORDER BY h\.rank/i);
    // Binds: the sanitized match expression, then the limit.
    expect(params).toEqual(['"spice"*', 50]);
  });
});

describe("reindexAll", () => {
  it("clears the index, pulls body text from R2, and inserts one row per message", async () => {
    const messages = [
      { id: "m1", subject: "Hello", msg_from: "a@x.com", msg_to: "b@y.com", msg_cc: null },
      { id: "m2", subject: "Bye", msg_from: "c@x.com", msg_to: "d@y.com", msg_cc: "e@z.com" },
    ];
    const { db, calls } = makeDb({ allResults: messages });
    const r2 = {
      get: vi.fn(async (key: string) => {
        if (key === "parsed/m1.json") return { json: async () => ({ text: "first body", html: "" }) };
        return null; // m2 has no parsed body → metadata-only index
      }),
    };
    const res = await reindexAll({ DB: db, MAILSTORE: r2 as any });
    expect(res.indexed).toBe(2);
    // The whole index is cleared before backfilling.
    expect(calls.some((c) => /DELETE FROM messages_fts$/i.test(c.sql.trim()))).toBe(true);
    const inserts = calls.filter((c) => /INSERT INTO messages_fts/i.test(c.sql));
    expect(inserts.length).toBe(2);
    expect(inserts[0].params).toEqual(["m1", "Hello", "a@x.com b@y.com", "first body"]);
    expect(inserts[1].params).toEqual(["m2", "Bye", "c@x.com d@y.com e@z.com", ""]);
  });
});
