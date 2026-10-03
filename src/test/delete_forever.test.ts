// "Delete forever" removes the trashed messages of a conversation. It must not
// take a reply that arrived while it ran, and a thread that picked up a new
// reply after being trashed has to stay deletable from the Trash view.
import { describe, it, expect, vi } from "vitest";
import { mutateThread, drainPendingDeletes } from "../store_mutations";
import { makeSqliteEnv, api, type SqliteEnv } from "./sqlite_env";

async function seed(t: SqliteEnv, id: string, state: string, threadId = "t1") {
  t.db
    .prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, subject, date, state, trashed_at, r2_raw_key)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, threadId, "in", "inbox", `subject ${id}`, 1, state, state === "trash" ? 5 : null, `raw/${id}.eml`);
  t.db.prepare(`INSERT INTO messages_fts (message_id, subject, participants, body) VALUES (?,?,?,?)`).run(id, "s", "p", "b");
  await t.env.MAILSTORE.put(`raw/${id}.eml`, "raw");
  await t.env.MAILSTORE.put(`parsed/${id}.json`, "{}");
  await t.env.MAILSTORE.put(`att/${id}/p0`, "bytes");
}

const ids = (t: SqliteEnv) =>
  (t.db.prepare(`SELECT id FROM messages ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
const ftsIds = (t: SqliteEnv) =>
  (t.db.prepare(`SELECT message_id FROM messages_fts ORDER BY message_id`).all() as { message_id: string }[]).map((r) => r.message_id);
const pending = (t: SqliteEnv) =>
  (t.db.prepare(`SELECT id FROM pending_deletes ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
const objectsFor = (t: SqliteEnv, id: string) => [...t.objects.keys()].filter((k) => k.includes(id)).sort();

describe("delete forever", () => {
  it("deletes a fully trashed thread: rows, R2 objects and FTS entries", async () => {
    const t = await makeSqliteEnv();
    await seed(t, "m1", "trash");
    await seed(t, "m2", "trash");
    await mutateThread(t.env, "t1", "delete", 1000);
    expect(ids(t)).toEqual([]);
    expect(ftsIds(t)).toEqual([]);
    expect(t.objects.size).toBe(0);
  });

  it("succeeds on a trashed thread that later received a reply, leaving the reply alone", async () => {
    const t = await makeSqliteEnv();
    await seed(t, "m1", "trash");
    await seed(t, "m2", "inbox"); // arrived after the thread was trashed

    const res = await api(t.env, "POST", "/api/threads/t1/mutate", { action: "delete" });

    expect(res.status).toBe(200);
    expect(ids(t)).toEqual(["m2"]);
    expect(ftsIds(t)).toEqual(["m2"]);
    expect(objectsFor(t, "m1")).toEqual([]);
    expect(objectsFor(t, "m2")).toEqual(["att/m2/p0", "parsed/m2.json", "raw/m2.eml"]);
  });

  it("does not delete a reply that arrives while the delete is running", async () => {
    const t = await makeSqliteEnv();
    await seed(t, "m1", "trash");
    // The reply lands after the thread's rows were read, during the R2 deletes.
    const realDelete = t.env.MAILSTORE.delete.bind(t.env.MAILSTORE);
    let arrived = false;
    (t.env.MAILSTORE as { delete: unknown }).delete = async (keys: string | string[]) => {
      if (!arrived) {
        arrived = true;
        await seed(t, "late", "inbox");
      }
      return realDelete(keys);
    };

    await mutateThread(t.env, "t1", "delete", 1000);

    expect(ids(t)).toEqual(["late"]);
    expect(objectsFor(t, "late")).toEqual(["att/late/p0", "parsed/late.json", "raw/late.eml"]);
  });

  it("still refuses when nothing in the thread is in trash", async () => {
    const t = await makeSqliteEnv();
    await seed(t, "m1", "inbox");
    await seed(t, "m2", "archived");
    const res = await api(t.env, "POST", "/api/threads/t1/mutate", { action: "delete" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trash/i);
    expect(ids(t)).toEqual(["m1", "m2"]);
    expect(t.objects.size).toBe(6);
  });

  it("is a no-op for a thread that does not exist", async () => {
    const t = await makeSqliteEnv();
    await expect(mutateThread(t.env, "nope", "delete", 1000)).resolves.toBeUndefined();
  });

  it("deletes a thread with more trashed messages than D1 allows bound parameters", async () => {
    const t = await makeSqliteEnv();
    for (let i = 0; i < 230; i++) await seed(t, `m${String(i).padStart(3, "0")}`, "trash");
    await mutateThread(t.env, "t1", "delete", 1000);
    expect(ids(t)).toEqual([]);
    expect(ftsIds(t)).toEqual([]);
    expect(t.objects.size).toBe(0);
  });

  it("a message restored between the read and the delete keeps its row AND its content", async () => {
    const t = await makeSqliteEnv();
    await seed(t, "m1", "trash");
    await seed(t, "m2", "trash");
    // Another request restores m1 after the thread's rows were read.
    const real = t.env.DB;
    (t.env as { DB: unknown }).DB = {
      prepare: (sql: string) => real.prepare(sql),
      // The restore commits just before the claiming transaction does.
      batch(stmts: never) {
        t.db.prepare(`UPDATE messages SET state='inbox', trashed_at=NULL WHERE id='m1'`).run();
        return real.batch(stmts);
      },
    };
    await mutateThread(t.env, "t1", "delete", 1000);
    expect(ids(t)).toEqual(["m1"]);
    expect(objectsFor(t, "m1")).toEqual(["att/m1/p0", "parsed/m1.json", "raw/m1.eml"]);
    expect(objectsFor(t, "m2")).toEqual([]);
  });

  it("is a 400 when everything was restored before the delete could claim it", async () => {
    const t = await makeSqliteEnv();
    await seed(t, "m1", "trash");
    const real = t.env.DB;
    (t.env as { DB: unknown }).DB = {
      prepare: (sql: string) => real.prepare(sql),
      // The restore commits just before the claiming transaction does.
      batch(stmts: never) {
        t.db.prepare(`UPDATE messages SET state='inbox', trashed_at=NULL WHERE id='m1'`).run();
        return real.batch(stmts);
      },
    };
    const res = await api(t.env, "POST", "/api/threads/t1/mutate", { action: "delete" });
    expect(res.status).toBe(400);
    expect(ids(t)).toEqual(["m1"]);
    expect(t.objects.size).toBe(3);
  });

  it("deletes the rows even when R2 is failing, leaving tombstones the drain later clears", async () => {
    const t = await makeSqliteEnv();
    await seed(t, "m1", "trash");
    await seed(t, "m2", "trash");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const realDelete = t.env.MAILSTORE.delete.bind(t.env.MAILSTORE);
    (t.env.MAILSTORE as { delete: unknown }).delete = async () => {
      throw new Error("R2 unavailable");
    };
    const res = await api(t.env, "POST", "/api/threads/t1/mutate", { action: "delete" });
    expect(res.status).toBe(200);
    expect(ids(t)).toEqual([]);
    expect(t.objects.size).toBe(6);
    expect(pending(t)).toEqual(["m1", "m2"]);

    (t.env.MAILSTORE as { delete: unknown }).delete = realDelete;
    await drainPendingDeletes(t.env, 2000);
    expect(t.objects.size).toBe(0);
    expect(ftsIds(t)).toEqual([]);
    expect(pending(t)).toEqual([]);
    errors.mockRestore();
  });

  it("still cleans up the chunks it claimed when a later chunk fails", async () => {
    const t = await makeSqliteEnv();
    for (let i = 0; i < 150; i++) await seed(t, `m${String(i).padStart(3, "0")}`, "trash");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = t.env.DB;
    let batches = 0;
    (t.env as { DB: unknown }).DB = {
      prepare: (sql: string) => real.prepare(sql),
      batch(stmts: never) {
        if (++batches === 2) throw new Error("D1_ERROR: Network connection lost.");
        return real.batch(stmts);
      },
    };
    const res = await api(t.env, "POST", "/api/threads/t1/mutate", { action: "delete" });
    expect(res.status).toBe(200); // some rows were deleted
    const left = ids(t);
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThan(150);
    // Everything claimed was cleaned or is tombstoned; nothing claimed is forgotten.
    const stillStored = new Set([...t.objects.keys()].map((k) => k.match(/m\d{3}/)![0]));
    for (const id of stillStored) expect(left.includes(id) || pending(t).includes(id), id).toBe(true);
    errors.mockRestore();
  });

  it("deletes nothing if the tombstone table is missing", async () => {
    const t = await makeSqliteEnv();
    await seed(t, "m1", "trash");
    t.db.exec("DROP TABLE pending_deletes");
    const res = await api(t.env, "POST", "/api/threads/t1/mutate", { action: "delete" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pending_deletes/);
    expect(ids(t)).toEqual(["m1"]);
    expect(t.objects.size).toBe(3);
  });
});
