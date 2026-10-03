// A long conversation is read from its newest end: the reader opens on the
// latest message, so a cap that keeps the OLDEST 100 hides exactly the mail the
// user came for.
import { describe, it, expect } from "vitest";
import { makeSqliteEnv, api, type SqliteEnv } from "./sqlite_env";

function seed(t: SqliteEnv, count: number, threadId = "<root@example.com>") {
  const insert = t.db.prepare(
    `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, date, envelope_to)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let i = 1; i <= count; i++) {
    insert.run(`m${i}`, threadId, "in", "inbox", "a@example.com", "me@example.com", `msg ${i}`, i * 1000, "me@example.com");
  }
}

const threadPath = (id: string) => `/api/threads/${encodeURIComponent(id)}`;

describe("GET /api/threads/:id on a long thread", () => {
  it("returns the NEWEST 100 messages, oldest first, and says it was truncated", async () => {
    const t = await makeSqliteEnv();
    seed(t, 105);
    const res = await api(t.env, "GET", threadPath("<root@example.com>"));
    expect(res.status).toBe(200);
    const ids = res.body.messages.map((m: { id: string }) => m.id);
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe("m6");
    expect(ids[99]).toBe("m105");
    expect(res.body.truncated).toBe(true);
    expect(res.body.total).toBe(105);
  });

  it("reports the full count and no truncation for an ordinary thread", async () => {
    const t = await makeSqliteEnv();
    seed(t, 3);
    const res = await api(t.env, "GET", threadPath("<root@example.com>"));
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(res.body.truncated).toBe(false);
    expect(res.body.total).toBe(3);
  });

  it("is not truncated at exactly the cap", async () => {
    const t = await makeSqliteEnv();
    seed(t, 100);
    const res = await api(t.env, "GET", threadPath("<root@example.com>"));
    expect(res.body.messages).toHaveLength(100);
    expect(res.body.truncated).toBe(false);
    expect(res.body.total).toBe(100);
  });
});
