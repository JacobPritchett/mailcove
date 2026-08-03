import { describe, it, expect, vi } from "vitest";
import { parseAddressList, contactMatches, suggestContacts, MAX_CONTACTS } from "../contacts";
import { handleFetch, type Env } from "../index";

describe("parseAddressList", () => {
  it("splits a comma-joined header list", () => {
    expect(parseAddressList("a@x.com, b@y.com").map((c) => c.email)).toEqual(["a@x.com", "b@y.com"]);
  });

  it("pulls the address out of a display-name form", () => {
    expect(parseAddressList("Alice Smith <alice@x.com>")).toEqual([
      { email: "alice@x.com", name: "Alice Smith" },
    ]);
  });

  it("does not split inside a quoted display name", () => {
    // "Doe, John" is one recipient, not two.
    const out = parseAddressList('"Doe, John" <j@x.com>, b@y.com');
    expect(out.map((c) => c.email)).toEqual(["j@x.com", "b@y.com"]);
    expect(out[0].name).toBe("Doe, John");
  });

  it("does not split inside angle brackets", () => {
    expect(parseAddressList("A <a@x.com>, B <b@y.com>").map((c) => c.email)).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("lowercases addresses so duplicates collapse", () => {
    expect(parseAddressList("Alice@X.COM")[0].email).toBe("alice@x.com");
  });

  it("stays fast on a pathological run of angle brackets", () => {
    // Reachable from one inbound message: msg_from interpolates the sender's
    // display name raw. The old /^(.*)<([^>]+)>$/ backtracked quadratically
    // when it FAILED, ~570ms for 40k "<" - per keystroke, per matching row.
    const nasty = "<".repeat(40000) + ", real@y.com";
    const t0 = Date.now();
    const out = parseAddressList(nasty);
    expect(Date.now() - t0).toBeLessThan(150);
    void out;
  });

  it("rejects an address that is not actually sendable", () => {
    // "a@x.com>" passed the old loose check AND the client validator, so a
    // suggestion could put an unsendable address on a real message.
    expect(parseAddressList("a@x.com>, b@y.com").map((c) => c.email)).toEqual(["b@y.com"]);
  });

  it("survives a quoted name containing an angle bracket", () => {
    // depth used to move on "<" inside quotes, swallowing every later address.
    expect(parseAddressList('"a < b" <a@x.com>, c@y.com').map((c) => c.email)).toEqual([
      "a@x.com",
      "c@y.com",
    ]);
  });

  it("survives an escaped quote in a display name", () => {
    const out = parseAddressList('"Bob \\" Smith" <bob@x.com>, carol@y.com');
    expect(out.map((c) => c.email)).toEqual(["bob@x.com", "carol@y.com"]);
  });

  it("handles group syntax and semicolon lists", () => {
    expect(parseAddressList("Team: a@x.com, b@y.com;").map((c) => c.email)).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
    expect(parseAddressList("a@x.com; b@y.com").map((c) => c.email)).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("ignores an RFC 5322 comment rather than losing the address", () => {
    expect(parseAddressList("a@x.com (Alice), b@y.com").map((c) => c.email)).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("drops entries that are not plausibly addresses", () => {
    // Suggesting junk is worse than suggesting nothing.
    expect(parseAddressList("not an address")).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList("   ,  ")).toEqual([]);
  });
});

describe("contactMatches", () => {
  const c = { email: "alice@example.com", name: "Alice Smith" };

  it("matches on either address or name, case-insensitively", () => {
    expect(contactMatches(c, "ali")).toBe(true);
    expect(contactMatches(c, "SMITH")).toBe(true);
    expect(contactMatches(c, "example")).toBe(true);
  });

  it("matches everything on an empty query", () => {
    expect(contactMatches(c, "  ")).toBe(true);
  });

  it("rejects a non-match", () => {
    expect(contactMatches(c, "bob")).toBe(false);
  });
});

function makeDb(sent: string[], received: string[]) {
  return {
    prepare(sql: string) {
      return {
        bind: () => ({
          all: async () => ({
            results: (/folder='sent'/.test(sql) ? sent : received).map((addrs) => ({ addrs })),
          }),
        }),
      };
    },
  } as unknown as D1Database;
}

describe("suggestContacts", () => {
  it("filters on folder so the query can use idx_messages_folder_date", async () => {
    const seen: string[] = [];
    const db = {
      prepare(sql: string) {
        seen.push(sql);
        return { bind: () => ({ all: async () => ({ results: [] }) }) };
      },
    } as unknown as D1Database;

    await suggestContacts({ DB: db }, "");

    // direction alone forces a full scan plus a temp B-tree sort.
    expect(seen.some((q) => /folder='sent'/.test(q))).toBe(true);
    expect(seen.some((q) => /folder='inbox'/.test(q))).toBe(true);
  });

  it("ranks people you have written to above people who wrote to you", () => {
    const env = { DB: makeDb(["chosen@x.com"], ["stranger@y.com"]) };
    return suggestContacts(env, "").then((out) => {
      // You picked the first one; anyone at all can be the second.
      expect(out.map((c) => c.email)).toEqual(["chosen@x.com", "stranger@y.com"]);
    });
  });

  it("keeps newest-first order within a group and de-duplicates", async () => {
    const env = { DB: makeDb(["new@x.com", "old@x.com", "new@x.com"], []) };

    const out = await suggestContacts(env, "");

    expect(out.map((c) => c.email)).toEqual(["new@x.com", "old@x.com"]);
  });

  it("backfills a display name seen only on a later row", async () => {
    const env = { DB: makeDb(["a@x.com", "Alice <a@x.com>"], []) };

    const out = await suggestContacts(env, "");

    expect(out).toEqual([{ email: "a@x.com", name: "Alice" }]);
  });

  it("keeps someone you email above a stranger on a NAME query", async () => {
    // Sent rows for an address typed bare carry no display name, so filtering
    // during collection skipped them and the contact re-entered below
    // strangers via the received group.
    const env = {
      DB: makeDb(["bob@corp.com"], ["Jones Spam <spam@random.io>", "Bob Jones <bob@corp.com>"]),
    };

    const out = await suggestContacts(env, "jones");

    expect(out.map((c) => c.email)).toEqual(["bob@corp.com", "spam@random.io"]);
  });

  it("filters by the query", async () => {
    const env = { DB: makeDb(["alice@x.com", "bob@y.com"], []) };

    expect((await suggestContacts(env, "bob")).map((c) => c.email)).toEqual(["bob@y.com"]);
  });

  it("caps how many suggestions come back", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `u${i}@x.com`);
    const env = { DB: makeDb(many, []) };

    expect(await suggestContacts(env, "")).toHaveLength(MAX_CONTACTS);
  });
});

describe("GET /api/contacts", () => {
  const auth = { Authorization: "Bearer secret-token" };

  function makeEnv(db: D1Database) {
    return {
      DB: db,
      MAILSTORE: {} as unknown,
      AUTH_TOKEN: "secret-token",
      ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
      ACCESS_AUD: "aud",
    } as unknown as Env;
  }

  const ctx = {} as ExecutionContext;

  it("returns suggestions for the owner", async () => {
    const env = makeEnv(makeDb(["alice@x.com"], []));
    const req = new Request("https://inbox.example.com/api/contacts?q=ali", { headers: auth });

    const res = await handleFetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contacts: [{ email: "alice@x.com", name: "" }] });
  });

  it("returns nothing for a query below the minimum, server side", async () => {
    // Without this a bare GET /api/contacts dumps the address book.
    const env = makeEnv(makeDb(["alice@x.com"], []));
    const res = await handleFetch(
      new Request("https://inbox.example.com/api/contacts", { headers: auth }),
      env,
      ctx,
    );

    expect(await res.json()).toEqual({ contacts: [] });
  });

  it("degrades to no suggestions instead of failing compose", async () => {
    const db = {
      prepare: () => ({ bind: () => ({ all: async () => { throw new Error("D1 down"); } }) }),
    } as unknown as D1Database;
    const req = new Request("https://inbox.example.com/api/contacts", { headers: auth });

    const res = await handleFetch(req, makeEnv(db), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contacts: [] });
  });

});
