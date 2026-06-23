import { describe, it, expect } from "vitest";
import { isDomainName, listThreadsByView, countsByDomain } from "../store_views";

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
        // countsByDomain runs parameterless.
        all: async () => {
          calls.push({ sql, binds: [] });
          return { results: rows };
        },
      };
    },
  };
  return { env: { DB: db } as any, calls };
}

describe("isDomainName", () => {
  it("accepts hostnames, rejects junk and injection shapes", () => {
    expect(isDomainName("example.org")).toBe(true);
    expect(isDomainName("sub.example-domain.com")).toBe(true);
    expect(isDomainName("")).toBe(false);
    expect(isDomainName("a b.com")).toBe(false);
    expect(isDomainName("x' OR 1=1")).toBe(false);
    expect(isDomainName(null)).toBe(false);
    expect(isDomainName(123)).toBe(false);
  });
});

describe("listThreadsByView domain filter", () => {
  it("exposes the latest-message domain column even when unfiltered", async () => {
    const { env, calls } = recordingDb();
    await listThreadsByView(env, "inbox");
    expect(calls[0].sql).toMatch(/AS domain/);
    expect(calls[0].binds).toEqual([200]);
  });

  it("filters on the derived domain (lowercased), binding before the limit", async () => {
    const { env, calls } = recordingDb();
    await listThreadsByView(env, "inbox", 200, undefined, "Example.ORG");
    expect(calls[0].sql).toMatch(/\)\s*WHERE domain = \?/);
    expect(calls[0].binds).toEqual(["example.org", 200]);
  });

  it("includes legacy NULL-domain rows when filtering by the default domain", async () => {
    const { env, calls } = recordingDb();
    await listThreadsByView(env, "inbox", 200, undefined, "example.com", true);
    expect(calls[0].sql).toMatch(/\(domain = \? OR domain IS NULL\)/);
    expect(calls[0].binds).toEqual(["example.com", 200]);
  });

  it("combines category and domain filters in bind order (category, domain, limit)", async () => {
    const { env, calls } = recordingDb();
    await listThreadsByView(env, "inbox", 200, "updates", "example.org");
    expect(calls[0].sql).toMatch(/WHERE category = \? AND domain = \?/);
    expect(calls[0].binds).toEqual(["updates", "example.org", 200]);
  });
});

describe("countsByDomain", () => {
  it("groups inbox threads/unread by domain", async () => {
    const rows = [
      { domain: "example.org", threads: 3, unread: 1 },
      { domain: "example.com", threads: 9, unread: 2 },
    ];
    const { env, calls } = recordingDb(rows);
    const out = await countsByDomain(env);
    expect(out).toEqual(rows);
    expect(calls[0].sql).toMatch(/direction='in' AND state='inbox'/);
    expect(calls[0].sql).toMatch(/GROUP BY COALESCE\(domain, ''\)/);
  });
});
