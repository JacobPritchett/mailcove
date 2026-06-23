import { describe, it, expect } from "vitest";
import { MAIL_ACTIONS, isMailAction, mutateThread } from "../store_mutations";

function makeDb() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const rows = [
    { id: "m1", thread_id: "t1", state: "inbox", starred: 0, unread: 1, r2_raw_key: "raw/m1.eml" },
    { id: "m2", thread_id: "t1", state: "inbox", starred: 0, unread: 0, r2_raw_key: "raw/m2.eml" },
  ];
  const db = {
    prepare(sql: string) {
      return { bind(...params: unknown[]) {
        calls.push({ sql, params });
        return {
          run: async () => ({}),
          all: async () => ({ results: rows.filter((r) => r.thread_id === params[params.length - 1]) }),
          first: async () => null,
        };
      } };
    },
  };
  return { db, calls };
}
const env = (db: unknown) => ({ DB: db, MAILSTORE: { delete: async () => {}, list: async () => ({ objects: [], truncated: false }) } } as never);

describe("MAIL_ACTIONS / isMailAction", () => {
  it("allow-lists exactly the 9 actions", () => {
    expect([...MAIL_ACTIONS].sort()).toEqual(
      ["archive", "delete", "read", "restore", "star", "trash", "unarchive", "unread", "unstar"],
    );
    expect(isMailAction("archive")).toBe(true);
    expect(isMailAction("nuke")).toBe(false);
  });
});

describe("mutateThread", () => {
  it("trash sets state='trash' + captures pre_trash_state for the whole thread", async () => {
    const { db, calls } = makeDb();
    await mutateThread(env(db), "t1", "trash", 1000);
    const upd = calls.find((c) => /state='trash', trashed_at=\?/.test(c.sql));
    expect(upd).toBeTruthy();
    expect(upd!.sql).toMatch(/pre_trash_state = CASE WHEN state!='trash'/);
    expect(upd!.params).toContain(1000);
    expect(upd!.params).toContain("t1");
  });
  it("restore returns to the captured pre_trash_state and clears trashed_at", async () => {
    const { db, calls } = makeDb();
    await mutateThread(env(db), "t1", "restore", 1000);
    expect(
      calls.some((c) =>
        /SET state=COALESCE\(pre_trash_state,'inbox'\), pre_trash_state=NULL, trashed_at=NULL/.test(c.sql),
      ),
    ).toBe(true);
  });
  it("delete refuses unless the thread is already in trash", async () => {
    const inboxDb = makeDb();
    await expect(mutateThread(env(inboxDb.db), "t1", "delete", 1000)).rejects.toThrow(/trash/i);
  });
});
