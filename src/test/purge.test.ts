import { it, expect } from "vitest";
import { purgeOldTrash } from "../store_mutations";

it("selects only trash older than the 30-day cutoff and deletes rows + R2", async () => {
  const deleted: string[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const old = [{ id: "m1", r2_raw_key: "raw/m1.eml" }];
  const db = { prepare(sql: string) { return { bind(...params: unknown[]) {
    queries.push({ sql, params });
    return { all: async () => ({ results: old }), run: async () => ({}), first: async () => null };
  } }; } };
  const env = { DB: db, MAILSTORE: { delete: async (k: string) => { deleted.push(k); }, list: async () => ({ objects: [], truncated: false }) } } as never;
  const now = 31 * 24 * 3600 * 1000;
  const res = await purgeOldTrash(env, now);
  const sel = queries.find((q) => /state='trash' AND trashed_at < \?/.test(q.sql));
  expect(sel!.params[0]).toBe(now - 30 * 24 * 3600 * 1000);
  expect(deleted).toContain("parsed/m1.json");
  expect(deleted).toContain("raw/m1.eml");
  expect(res.purged).toBe(1);
});

it("deletes attachment R2 objects enumerated by prefix", async () => {
  const deleted: string[] = [];
  const old = [{ id: "m1", r2_raw_key: "raw/m1.eml" }];
  const db = { prepare(_sql: string) { return { bind(..._params: unknown[]) {
    return { all: async () => ({ results: old }), run: async () => ({}), first: async () => null };
  } }; } };
  const env = { DB: db, MAILSTORE: {
    delete: async (k: string) => { deleted.push(k); },
    list: async ({ prefix }: { prefix: string }) =>
      prefix === "att/m1/"
        ? { objects: [{ key: "att/m1/file.pdf" }], truncated: false }
        : { objects: [], truncated: false },
  } } as never;
  const now = 31 * 24 * 3600 * 1000;
  await purgeOldTrash(env, now);
  expect(deleted).toContain("att/m1/file.pdf");
});
