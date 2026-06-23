import { describe, it, expect } from "vitest";
import { VIEWS, isView, viewWhere, isCategory, listThreadsByView } from "../store_views";
describe("view predicates", () => {
  it("maps each view to its WHERE", () => {
    expect(isView("inbox")).toBe(true);
    expect(isView("bogus")).toBe(false);
    expect([...VIEWS].sort()).toEqual(["all", "inbox", "sent", "starred", "trash"]);
    expect(viewWhere("inbox")).toMatch(/direction='in' AND state='inbox'/);
    expect(viewWhere("starred")).toMatch(/starred=1 AND state!='trash'/);
    expect(viewWhere("sent")).toMatch(/direction='out' AND state!='trash'/);
    expect(viewWhere("all")).toMatch(/state!='trash'/);
    expect(viewWhere("trash")).toMatch(/state='trash'/);
  });
});

describe("isCategory", () => {
  it("accepts the four labels and rejects others", () => {
    for (const c of ["primary", "promotions", "updates", "social"]) expect(isCategory(c)).toBe(true);
    for (const c of ["spam", "", "Primary", 1, null]) expect(isCategory(c)).toBe(false);
  });
});

/** Mock D1 that records the last prepared SQL + binds and returns fixed rows. */
function recordingDb(rows: unknown[] = []) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return { all: async () => ({ results: rows }) };
        },
      };
    },
  };
  return { env: { DB: db } as any, calls };
}

describe("listThreadsByView category filter", () => {
  it("selects the latest-message category and adds no outer filter when unfiltered", async () => {
    const { env, calls } = recordingDb();
    await listThreadsByView(env, "inbox");
    expect(calls[0].sql).toContain("category");
    // Outer wrapper present, but no category WHERE filter on it.
    expect(calls[0].sql).toContain("SELECT * FROM (");
    expect(calls[0].sql).not.toMatch(/\)\s*WHERE/);
    expect(calls[0].binds).toEqual([200]); // limit only
  });

  it("'primary' also matches NULL (uncategorized), binding only the limit", async () => {
    const { env, calls } = recordingDb();
    await listThreadsByView(env, "inbox", 200, "primary");
    expect(calls[0].sql).toContain("category = 'primary' OR category IS NULL");
    expect(calls[0].binds).toEqual([200]);
  });

  it("a non-primary category filters in the OUTER query, binding before the limit", async () => {
    const { env, calls } = recordingDb();
    await listThreadsByView(env, "inbox", 200, "promotions");
    // Filter is an outer WHERE on the derived table (not HAVING on a base alias).
    expect(calls[0].sql).toMatch(/\)\s*WHERE category = \?/);
    expect(calls[0].binds).toEqual(["promotions", 200]);
  });
});
