import { describe, it, expect, vi, beforeEach } from "vitest";

// applyFilters delegates filing to the message-scoped mutateMessage; spy on it.
vi.mock("../store_mutations", () => ({ mutateMessage: vi.fn(async () => undefined) }));

import { matchFilter, applyFilters, isFilterField, isFilterAction } from "../rules";
import { mutateMessage } from "../store_mutations";

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

// msg_from is a display serialization (names needing it are quoted and
// escaped). A rule is written against what the user sees, so matching must not
// depend on how the name happened to be stored.
describe("matchFilter on a quoted From", () => {
  const quoted = { from: '"Doe, John" <a@x.com>', to: "me@example.com", subject: "s" };
  const escaped = { from: '"John \\"Johnny\\" Doe" <j@x.com>', to: "me@example.com", subject: "s" };
  const plain = { from: "Alice Example <alice@shop.com>", to: "me@example.com", subject: "s" };

  it("equals matches the name as displayed, without the storage quotes", () => {
    expect(matchFilter({ field: "from", op: "equals", value: "Doe, John <a@x.com>" }, quoted)).toBe(true);
    expect(matchFilter({ field: "from", op: "equals", value: "doe, john <A@X.com>" }, quoted)).toBe(true);
  });
  it("equals also accepts the stored string and the bare address", () => {
    expect(matchFilter({ field: "from", op: "equals", value: '"Doe, John" <a@x.com>' }, quoted)).toBe(true);
    expect(matchFilter({ field: "from", op: "equals", value: "a@x.com" }, quoted)).toBe(true);
    expect(matchFilter({ field: "from", op: "equals", value: "alice@shop.com" }, plain)).toBe(true);
  });
  it("equals still rejects a partial or different value", () => {
    expect(matchFilter({ field: "from", op: "equals", value: "Doe, John" }, quoted)).toBe(false);
    expect(matchFilter({ field: "from", op: "equals", value: "x.com" }, quoted)).toBe(false);
    expect(matchFilter({ field: "from", op: "equals", value: "b@x.com" }, quoted)).toBe(false);
  });
  it("contains sees unescaped quotes inside a name", () => {
    expect(matchFilter({ field: "from", op: "contains", value: 'John "Johnny" Doe' }, escaped)).toBe(true);
    expect(matchFilter({ field: "from", op: "contains", value: '"johnny"' }, escaped)).toBe(true);
    expect(matchFilter({ field: "from", op: "contains", value: "Doe, John <a@" }, quoted)).toBe(true);
    expect(matchFilter({ field: "from", op: "contains", value: "nobody" }, escaped)).toBe(false);
  });
  it("an ordinary unquoted name matches exactly as before", () => {
    expect(matchFilter({ field: "from", op: "equals", value: "Alice Example <alice@shop.com>" }, plain)).toBe(true);
    expect(matchFilter({ field: "from", op: "contains", value: "alice ex" }, plain)).toBe(true);
    expect(matchFilter({ field: "from", op: "contains", value: "@shop.com" }, plain)).toBe(true);
    expect(matchFilter({ field: "from", op: "equals", value: "Alice" }, plain)).toBe(false);
  });
  it("falls back to the stored string when From is not a parseable mailbox", () => {
    const odd = { from: "MAILER-DAEMON", to: "me@example.com", subject: "s" };
    expect(matchFilter({ field: "from", op: "equals", value: "mailer-daemon" }, odd)).toBe(true);
    expect(matchFilter({ field: "from", op: "contains", value: "daemon" }, odd)).toBe(true);
  });
  it("does not apply sender decoding to other fields", () => {
    expect(matchFilter({ field: "subject", op: "equals", value: "a@x.com" }, { from: "x", to: "y", subject: "Hi <a@x.com>" })).toBe(false);
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
  beforeEach(() => vi.mocked(mutateMessage).mockClear());

  it("applies a matching archive rule to the message and reports it left the inbox", async () => {
    const { env } = makeEnv([
      { id: "f1", field: "from", op: "contains", value: "shop.com", action: "archive", enabled: 1, position: 0 },
    ]);
    const r = await applyFilters(env, "m1", target, 1000);
    expect(r.applied).toEqual(["archive"]);
    expect(r.leftInbox).toBe(true);
    expect(mutateMessage).toHaveBeenCalledWith(env, "m1", "archive", 1000);
  });

  it("stacks star/read but skips a second filing action after archive", async () => {
    const { env } = makeEnv([
      { id: "f1", field: "subject", op: "contains", value: "sale", action: "star", enabled: 1, position: 0 },
      { id: "f2", field: "from", op: "contains", value: "shop", action: "archive", enabled: 1, position: 1 },
      { id: "f3", field: "to", op: "contains", value: "me@", action: "trash", enabled: 1, position: 2 },
    ]);
    const r = await applyFilters(env, "m1", target, 1000);
    // star + archive apply; the later trash (also a filing action) is skipped.
    expect(r.applied).toEqual(["star", "archive"]);
    expect(r.leftInbox).toBe(true);
    const actions = vi.mocked(mutateMessage).mock.calls.map((c) => c[2]);
    expect(actions).toEqual(["star", "archive"]);
  });

  it("does nothing when no rule matches", async () => {
    const { env } = makeEnv([
      { id: "f1", field: "subject", op: "equals", value: "nope", action: "trash", enabled: 1, position: 0 },
    ]);
    const r = await applyFilters(env, "m1", target, 1000);
    expect(r.applied).toEqual([]);
    expect(r.leftInbox).toBe(false);
    expect(mutateMessage).not.toHaveBeenCalled();
  });
});
