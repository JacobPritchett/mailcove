import { describe, it, expect, vi, beforeEach } from "vitest";

// applyFilters delegates filing to the app's mutateThread; spy on it.
vi.mock("../store_mutations", () => ({ mutateThread: vi.fn(async () => undefined) }));

import { matchFilter, applyFilters, isFilterField, isFilterAction } from "../rules";
import { mutateThread } from "../store_mutations";

describe("matchFilter", () => {
  const target = { from: "Alice <alice@shop.com>", to: "me@example.com", subject: "50% OFF Sale" };
  it("contains is case-insensitive substring", () => {
    expect(matchFilter({ field: "subject", op: "contains", value: "sale" }, target)).toBe(true);
    expect(matchFilter({ field: "from", op: "contains", value: "alice@shop" }, target)).toBe(true);
    expect(matchFilter({ field: "subject", op: "contains", value: "refund" }, target)).toBe(false);
  });
  it("equals matches the whole trimmed field", () => {
    expect(matchFilter({ field: "to", op: "equals", value: "me@example.com" }, target)).toBe(true);
    expect(matchFilter({ field: "to", op: "equals", value: "me@" }, target)).toBe(false);
  });
  it("empty value never matches", () => {
    expect(matchFilter({ field: "subject", op: "contains", value: "  " }, target)).toBe(false);
  });
});

describe("guards", () => {
  it("validate field/action enums", () => {
    expect(isFilterField("from")).toBe(true);
    expect(isFilterField("cc")).toBe(false);
    expect(isFilterAction("archive")).toBe(true);
    expect(isFilterAction("explode")).toBe(false);
  });
});

/** Mock D1 whose filters SELECT returns fixed rows. */
function makeEnv(rows: unknown[]) {
  const db = {
    prepare() {
      return {
        bind() {
          return { all: async () => ({ results: rows }), run: async () => ({}) };
        },
        all: async () => ({ results: rows }),
      };
    },
  };
  return { env: { DB: db, MAILSTORE: {} } as any };
}

describe("applyFilters", () => {
  const target = { from: "deals@shop.com", to: "me@example.com", subject: "Big Sale" };
  beforeEach(() => vi.mocked(mutateThread).mockClear());

  it("applies a matching archive rule (thread-level) and reports it left the inbox", async () => {
    const { env } = makeEnv([
      { id: "f1", field: "from", op: "contains", value: "shop.com", action: "archive", enabled: 1, position: 0 },
    ]);
    const r = await applyFilters(env, "t1", target, 1000);
    expect(r.applied).toEqual(["archive"]);
    expect(r.leftInbox).toBe(true);
    expect(mutateThread).toHaveBeenCalledWith(env, "t1", "archive", 1000);
  });

  it("stacks star/read but skips a second filing action after archive", async () => {
    const { env } = makeEnv([
      { id: "f1", field: "subject", op: "contains", value: "sale", action: "star", enabled: 1, position: 0 },
      { id: "f2", field: "from", op: "contains", value: "shop", action: "archive", enabled: 1, position: 1 },
      { id: "f3", field: "to", op: "contains", value: "me@", action: "trash", enabled: 1, position: 2 },
    ]);
    const r = await applyFilters(env, "t1", target, 1000);
    // star + archive apply; the later trash (also a filing action) is skipped.
    expect(r.applied).toEqual(["star", "archive"]);
    expect(r.leftInbox).toBe(true);
    const actions = vi.mocked(mutateThread).mock.calls.map((c) => c[2]);
    expect(actions).toEqual(["star", "archive"]);
  });

  it("does nothing when no rule matches", async () => {
    const { env } = makeEnv([
      { id: "f1", field: "subject", op: "equals", value: "nope", action: "trash", enabled: 1, position: 0 },
    ]);
    const r = await applyFilters(env, "t1", target, 1000);
    expect(r.applied).toEqual([]);
    expect(r.leftInbox).toBe(false);
    expect(mutateThread).not.toHaveBeenCalled();
  });
});
