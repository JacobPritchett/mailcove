import { describe, it, expect, vi } from "vitest";
import { getThread, findThreadIdByMessageIds } from "../store";

// Minimal D1 + R2 mocks. The D1 stub records the SQL it was prepared with so we
// can assert ordering is delegated to SQL (date ASC), and returns rows in that
// order. R2.get resolves a parsed body JSON per id.
function makeEnv(rows: any[], bodies: Record<string, any>) {
  let lastSql = "";
  const db = {
    prepare(sql: string) {
      lastSql = sql;
      return {
        bind() {
          return {
            all: async () => ({ results: rows }),
          };
        },
      };
    },
    get _sql() {
      return lastSql;
    },
  };
  const r2 = {
    get: vi.fn(async (key: string) => {
      const id = key.replace(/^parsed\//, "").replace(/\.json$/, "");
      const body = bodies[id];
      if (!body) return null;
      return { json: async () => body };
    }),
  };
  return { DB: db as any, MAILSTORE: r2 as any };
}

describe("getThread", () => {
  it("orders by date ASC in SQL and attaches each message body", async () => {
    const rows = [
      { id: "a", thread_id: "t1", date: 100, subject: "first" },
      { id: "b", thread_id: "t1", date: 200, subject: "second" },
    ];
    const bodies = {
      a: { text: "body a", html: "", attachments: [] },
      b: { text: "body b", html: "<p>b</p>", attachments: [] },
    };
    const env = makeEnv(rows, bodies);

    const result = await getThread(env as any, "t1");

    expect(result.thread_id).toBe("t1");
    expect(result.messages.map((m: any) => m.id)).toEqual(["a", "b"]);
    expect((env.DB as any)._sql).toMatch(/ORDER BY date ASC/i);
    // Each message carries its body loaded from R2.
    expect(result.messages[0].body.text).toBe("body a");
    expect(result.messages[1].body.html).toBe("<p>b</p>");
  });

  it("falls back to an empty body when the R2 object is missing", async () => {
    const rows = [{ id: "a", thread_id: "t1", date: 100, subject: "only" }];
    const env = makeEnv(rows, {}); // no body stored
    const result = await getThread(env as any, "t1");
    expect(result.messages[0].body).toEqual({ text: "", html: "", attachments: [] });
  });
});

// A D1 stub that records the prepared SQL + bound params and returns a fixed
// first() row, so we can assert query shape and the empty-candidates short-circuit.
function makeLookupDb(firstRow: any) {
  const calls: { sql: string; params: any[] }[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, params: [] as any[] };
      calls.push(call);
      return {
        bind(...params: any[]) {
          call.params = params;
          return {
            first: async () => firstRow,
          };
        },
      };
    },
    _calls: calls,
  };
  return db;
}

describe("findThreadIdByMessageIds", () => {
  it("returns null and runs no query for empty candidates", async () => {
    const db = makeLookupDb({ thread_id: "should-not-be-used" });
    const result = await findThreadIdByMessageIds(db as any, []);
    expect(result).toBeNull();
    expect(db._calls.length).toBe(0);
  });

  it("returns the thread_id of the earliest matching stored row", async () => {
    const db = makeLookupDb({ thread_id: "root-thread" });
    const result = await findThreadIdByMessageIds(db as any, [
      "<a@x>",
      "<b@x>",
    ]);
    expect(result).toBe("root-thread");
    // One placeholder per candidate, ordered earliest-first, single result.
    expect(db._calls[0].sql).toMatch(/SELECT thread_id FROM messages/i);
    expect(db._calls[0].sql).toMatch(/message_id IN \(\?,\?\)/i);
    expect(db._calls[0].sql).toMatch(/ORDER BY date ASC/i);
    expect(db._calls[0].sql).toMatch(/LIMIT 1/i);
    expect(db._calls[0].params).toEqual(["<a@x>", "<b@x>"]);
  });

  it("returns null when no row matches", async () => {
    const db = makeLookupDb(null);
    const result = await findThreadIdByMessageIds(db as any, ["<none@x>"]);
    expect(result).toBeNull();
  });
});
