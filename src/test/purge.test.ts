// The daily purge permanently removes mail trashed more than 30 days ago. Rows
// are claimed in one transaction that writes a tombstone (pending_deletes) for
// each row it deletes, so a restore either wins (row and content both survive)
// or loses (nothing left to restore), and there is always a record of whose
// search entry and stored objects still have to go. The drain works through
// those records and removes one only when its cleanup fully succeeded.
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../index";
import { purgeOldTrash, drainPendingDeletes, PURGE_BATCH } from "../store_mutations";
import { makeSqliteEnv, type SqliteEnv } from "./sqlite_env";

const DAY = 24 * 3600 * 1000;
const NOW = 400 * DAY;

async function seedTrashed(t: SqliteEnv, id: string, trashedAt: number, state = "trash") {
  t.db
    .prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, subject, date, state, trashed_at, r2_raw_key)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, `t-${id}`, "in", "inbox", `subject ${id}`, 1, state, trashedAt, `raw/${id}.eml`);
  t.db.prepare(`INSERT INTO messages_fts (message_id, subject, participants, body) VALUES (?,?,?,?)`).run(id, "s", "p", "b");
  await t.env.MAILSTORE.put(`raw/${id}.eml`, "raw");
  await t.env.MAILSTORE.put(`parsed/${id}.json`, "{}");
  await t.env.MAILSTORE.put(`att/${id}/p0`, "bytes");
}

const ids = (t: SqliteEnv) =>
  (t.db.prepare(`SELECT id FROM messages ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
const ftsIds = (t: SqliteEnv) =>
  (t.db.prepare(`SELECT message_id FROM messages_fts ORDER BY message_id`).all() as { message_id: string }[]).map((r) => r.message_id);
const objectsFor = (t: SqliteEnv, id: string) => [...t.objects.keys()].filter((k) => k.includes(id)).sort();

afterEach(() => vi.restoreAllMocks());

describe("purgeOldTrash", () => {
  it("removes only trash older than the 30-day cutoff: row, R2 objects and FTS entry", async () => {
    const t = await makeSqliteEnv();
    await seedTrashed(t, "old", NOW - 31 * DAY);
    await seedTrashed(t, "recent", NOW - 29 * DAY);
    await seedTrashed(t, "restored", NOW - 31 * DAY, "inbox");

    const res = await purgeOldTrash(t.env, NOW);

    expect(res.purged).toBe(1);
    expect(ids(t)).toEqual(["recent", "restored"]);
    expect(ftsIds(t)).toEqual(["recent", "restored"]);
    expect(objectsFor(t, "old")).toEqual([]);
    expect(t.objects.has("att/recent/p0")).toBe(true);
    expect(t.objects.has("raw/restored.eml")).toBe(true);
  });

  it("is bounded per run and takes the oldest first", async () => {
    const t = await makeSqliteEnv();
    const extra = 7;
    for (let i = 0; i < PURGE_BATCH + extra; i++) {
      // Higher i = trashed longer ago.
      await seedTrashed(t, `m${String(i).padStart(4, "0")}`, NOW - (40 + i) * DAY);
    }

    const first = await purgeOldTrash(t.env, NOW);
    expect(first.purged).toBe(PURGE_BATCH);
    // The newest `extra` are what is left for the next run.
    expect(ids(t)).toEqual(Array.from({ length: extra }, (_, i) => `m${String(i).padStart(4, "0")}`));

    const second = await purgeOldTrash(t.env, NOW);
    expect(second.purged).toBe(extra);
    expect(ids(t)).toEqual([]);
    expect(t.objects.size).toBe(0);
  });

  it("a restore that lands while the purge is deleting objects cannot leave a row without its body", async () => {
    const t = await makeSqliteEnv();
    await seedTrashed(t, "a", NOW - 40 * DAY);
    // The restore request arrives during the R2 phase. By then the row has
    // been claimed, so the restore finds nothing; no body-less inbox message.
    const realList = t.env.MAILSTORE.list.bind(t.env.MAILSTORE);
    let restored = 0;
    (t.env.MAILSTORE as { list: unknown }).list = async (o: never) => {
      restored += Number(
        t.db.prepare(`UPDATE messages SET state='inbox', trashed_at=NULL WHERE id='a' AND state='trash'`).run().changes,
      );
      return realList(o);
    };
    await purgeOldTrash(t.env, NOW);
    expect(restored).toBe(0);
    expect(ids(t)).toEqual([]);
  });

  it("a message restored before the purge claims it keeps its row AND its content", async () => {
    const t = await makeSqliteEnv();
    await seedTrashed(t, "a", NOW - 40 * DAY);
    await seedTrashed(t, "b", NOW - 41 * DAY);
    // Restore "a" at the last possible moment: just before the claim commits.
    const real = t.env.DB;
    (t.env as { DB: unknown }).DB = {
      prepare: (sql: string) => real.prepare(sql),
      batch(stmts: never) {
        t.db.prepare(`UPDATE messages SET state='inbox', trashed_at=NULL WHERE id='a'`).run();
        return real.batch(stmts);
      },
    };
    const res = await purgeOldTrash(t.env, NOW);
    expect(res.purged).toBe(1);
    expect(ids(t)).toEqual(["a"]);
    expect(objectsFor(t, "a")).toEqual(["att/a/p0", "parsed/a.json", "raw/a.eml"]);
    expect(objectsFor(t, "b")).toEqual([]);
  });

  it("still purges the rows when R2 is failing, and leaves a tombstone for each", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await makeSqliteEnv();
    await seedTrashed(t, "a", NOW - 40 * DAY);
    await seedTrashed(t, "b", NOW - 41 * DAY);
    (t.env.MAILSTORE as { delete: unknown }).delete = async () => {
      throw new Error("R2 unavailable");
    };
    const res = await purgeOldTrash(t.env, NOW);
    expect(res).toEqual({ purged: 2, pending: 2 });
    expect(ids(t)).toEqual([]);
    expect(t.objects.size).toBe(6);
    expect(pending(t)).toEqual([
      { id: "a", r2_raw_key: "raw/a.eml" },
      { id: "b", r2_raw_key: "raw/b.eml" },
    ]);
  });

  it("leaves no tombstone behind when cleanup succeeds", async () => {
    const t = await makeSqliteEnv();
    await seedTrashed(t, "a", NOW - 40 * DAY);
    expect(await purgeOldTrash(t.env, NOW)).toEqual({ purged: 1, pending: 0 });
    expect(pending(t)).toEqual([]);
  });

  it("deletes nothing if the tombstone table is missing", async () => {
    const t = await makeSqliteEnv();
    await seedTrashed(t, "a", NOW - 40 * DAY);
    t.db.exec("DROP TABLE pending_deletes");
    await expect(purgeOldTrash(t.env, NOW)).rejects.toThrow(/pending_deletes/);
    // The claim is one transaction: no tombstone, no delete.
    expect(ids(t)).toEqual(["a"]);
    expect(objectsFor(t, "a")).toHaveLength(3);
  });
});

const pending = (t: SqliteEnv) =>
  t.db.prepare(`SELECT id, r2_raw_key FROM pending_deletes ORDER BY id`).all() as { id: string; r2_raw_key: string | null }[];

/** A tombstone for a message whose row is already gone, with its leftovers. */
async function seedTombstone(t: SqliteEnv, id: string, created: number) {
  t.db.prepare(`INSERT INTO pending_deletes (id, r2_raw_key, created) VALUES (?,?,?)`).run(id, `raw/${id}.eml`, created);
  t.db.prepare(`INSERT INTO messages_fts (message_id, subject, participants, body) VALUES (?,?,?,?)`).run(id, "s", "p", "secret body");
  await t.env.MAILSTORE.put(`raw/${id}.eml`, "raw");
  await t.env.MAILSTORE.put(`parsed/${id}.json`, "{}");
  await t.env.MAILSTORE.put(`att/${id}/p0`, "bytes");
}

describe("drainPendingDeletes", () => {
  it("finishes what an interrupted purge left: search entry, raw, parsed, attachments, tombstone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await makeSqliteEnv();
    await seedTrashed(t, "a", NOW - 40 * DAY);
    const realDelete = t.env.MAILSTORE.delete.bind(t.env.MAILSTORE);
    (t.env.MAILSTORE as { delete: unknown }).delete = async () => {
      throw new Error("R2 unavailable");
    };
    await purgeOldTrash(t.env, NOW);
    expect(objectsFor(t, "a")).toHaveLength(3);

    (t.env.MAILSTORE as { delete: unknown }).delete = realDelete;
    expect(await drainPendingDeletes(t.env, NOW + DAY)).toEqual({ drained: 1, failed: 0 });
    expect(objectsFor(t, "a")).toEqual([]); // the raw message too
    expect(ftsIds(t)).toEqual([]);
    expect(pending(t)).toEqual([]);
  });

  it("keeps the tombstone when the search-index delete fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await makeSqliteEnv();
    await seedTombstone(t, "a", 1);
    const real = t.env.DB;
    (t.env as { DB: unknown }).DB = {
      batch: real.batch,
      prepare(sql: string) {
        if (/DELETE FROM messages_fts/.test(sql)) throw new Error("D1 unavailable");
        return real.prepare(sql);
      },
    };
    expect(await drainPendingDeletes(t.env, NOW)).toEqual({ drained: 0, failed: 1 });
    expect(pending(t).map((p) => p.id)).toEqual(["a"]);
    expect(ftsIds(t)).toEqual(["a"]);

    (t.env as { DB: unknown }).DB = real;
    expect(await drainPendingDeletes(t.env, NOW)).toEqual({ drained: 1, failed: 0 });
    expect(ftsIds(t)).toEqual([]);
    expect(pending(t)).toEqual([]);
  });

  it("a tombstone that keeps failing does not stop or starve the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await makeSqliteEnv();
    const LIMIT = 100;
    // The oldest LIMIT tombstones can never be cleaned; newer ones can.
    for (let i = 0; i < LIMIT; i++) await seedTombstone(t, `bad${String(i).padStart(3, "0")}`, 1 + i);
    for (let i = 0; i < 5; i++) await seedTombstone(t, `good${i}`, 1000 + i);
    const realDelete = t.env.MAILSTORE.delete.bind(t.env.MAILSTORE);
    (t.env.MAILSTORE as { delete: unknown }).delete = async (keys: string | string[]) => {
      if ((Array.isArray(keys) ? keys : [keys]).some((k) => k.includes("bad"))) throw new Error("R2 unavailable");
      return realDelete(keys);
    };
    const first = await drainPendingDeletes(t.env, NOW);
    expect(first).toEqual({ drained: 0, failed: LIMIT }); // every failure was attempted, none stopped the batch
    const second = await drainPendingDeletes(t.env, NOW + 1);
    expect(second).toEqual({ drained: 5, failed: LIMIT - 5 }); // ALL the failures went to the back of the queue
    expect(pending(t).filter((p) => p.id.startsWith("good"))).toEqual([]);
    expect(pending(t)).toHaveLength(LIMIT);
  });

  it("is bounded per call", async () => {
    const t = await makeSqliteEnv();
    for (let i = 0; i < 130; i++) await seedTombstone(t, `m${String(i).padStart(3, "0")}`, i);
    expect((await drainPendingDeletes(t.env, NOW)).drained).toBe(100);
    expect(pending(t)).toHaveLength(30);
    expect((await drainPendingDeletes(t.env, NOW)).drained).toBe(30);
    expect(t.objects.size).toBe(0);
  });

  it("never deletes content for an id that has a message row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await makeSqliteEnv();
    await seedTombstone(t, "live", 1);
    t.db.prepare(`INSERT INTO messages (id, thread_id, direction, folder, date) VALUES ('live','t','in','inbox',1)`).run();
    expect(await drainPendingDeletes(t.env, NOW)).toEqual({ drained: 0, failed: 0 });
    expect(objectsFor(t, "live")).toHaveLength(3);
    expect(ftsIds(t)).toEqual(["live"]);
    expect(pending(t)).toEqual([]); // the bogus tombstone is discarded
  });

  it("does nothing, cheaply, when there is nothing pending", async () => {
    const t = await makeSqliteEnv();
    await t.env.MAILSTORE.put("raw/0aaaaaaa-0000-4000-8000-000000000001.eml", "row-less but not tombstoned");
    const lists = vi.spyOn(t.env.MAILSTORE, "list");
    expect(await drainPendingDeletes(t.env, NOW)).toEqual({ drained: 0, failed: 0 });
    expect(lists).not.toHaveBeenCalled();
    expect(t.objects.size).toBe(1); // nothing is deleted merely for having no row
  });
});

describe("scheduled handler", () => {
  it("drains leftover tombstones", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv();
    await seedTombstone(t, "left", 1);
    await worker.scheduled!({} as ScheduledController, t.env, {} as ExecutionContext);
    expect(pending(t)).toEqual([]);
    expect(objectsFor(t, "left")).toEqual([]);
  });

  it("runs every sweep even when the ones before it throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv();
    const listed: string[] = [];
    const realList = t.env.MAILSTORE.list.bind(t.env.MAILSTORE);
    (t.env.MAILSTORE as { list: unknown }).list = async (o: { prefix: string }) => {
      listed.push(o.prefix);
      return realList(o as never);
    };
    // Every D1 call fails: the purge cannot claim and the drain cannot read.
    const attempted: string[] = [];
    (t.env as { DB: unknown }).DB = {
      prepare(sql: string) {
        attempted.push(sql);
        throw new Error("D1 unavailable");
      },
      batch() {
        throw new Error("D1 unavailable");
      },
    };

    await expect(
      worker.scheduled!({} as ScheduledController, t.env, {} as ExecutionContext),
    ).resolves.toBeUndefined();

    expect(attempted.some((q) => /FROM pending_deletes/.test(q))).toBe(true); // the drain ran after the purge threw
    expect(listed).toContain("draftatt/"); // and the draft sweep still ran
  });
});
