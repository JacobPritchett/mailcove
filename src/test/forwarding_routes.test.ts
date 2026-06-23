import { describe, it, expect, vi, afterEach } from "vitest";
import { handleFetch, type Env } from "../index";
import { forwardCopyFor } from "../domains";

// Route-level tests for the forwarding-power endpoints: per-address rules,
// destination registration, and the per-domain forward-copy setting.

const ctx = {} as ExecutionContext;

function cf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordingFetch(routes: { match: string; method?: string; res: () => Response }[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes.find((r) => url.includes(r.match) && (!r.method || r.method === method));
    if (!hit) throw new Error(`unrouted fetch: ${method} ${url}`);
    return hit.res();
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

function makeEnv(domainRow: Record<string, unknown> | null = null) {
  const statements: { sql: string; params: any[] }[] = [];
  const db = {
    prepare(sql: string) {
      const rec = { sql, params: [] as any[] };
      const stmt = {
        bind(...params: any[]) {
          rec.params = params;
          return stmt;
        },
        run: async () => {
          statements.push(rec);
          return {};
        },
        first: async () => (/FROM domains\b/i.test(sql) ? domainRow : null),
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
  };
  const env = {
    DB: db as any,
    MAILSTORE: {} as any,
    AUTH_TOKEN: "secret-token",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    CF_API_TOKEN: "cf-tok",
    CF_ACCOUNT_ID: "acct123",
    INBOX_WORKER_NAME: "mailcove",
    INBOX_DOMAIN: "example.com",
    FROM_DOMAIN: "send.example.com",
    DEFAULT_FROM_LOCAL: "hello",
    FORWARD_COPY_TO: "alex@example.com",
  } as unknown as Env;
  return { env, statements };
}

function req(path: string, method: string, body?: unknown) {
  return new Request(`https://inbox.example.com${path}`, {
    method,
    headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ZONES = {
  match: "/zones?",
  res: () =>
    cf({
      success: true,
      result: [{ id: "z1", name: "a.com", status: "active" }],
      result_info: { page: 1, total_pages: 1 },
    }),
};

describe("POST /api/domains/:zoneId/rules", () => {
  it("builds the matched address server-side from the zone name", async () => {
    const { env } = makeEnv();
    const calls = recordingFetch([
      ZONES,
      { match: "/email/routing/rules", method: "POST", res: () => cf({ success: true, result: { id: "r1" } }) },
    ]);
    const res = await handleFetch(req("/api/domains/z1/rules", "POST", { local: "Sales", action: "inbox" }), env, ctx);
    expect(res.status).toBe(200);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      matchers: [{ type: "literal", field: "to", value: "sales@a.com" }],
      actions: [{ type: "worker", value: ["mailcove"] }],
    });
  });

  it("rejects bad local parts and actions", async () => {
    const { env } = makeEnv();
    recordingFetch([ZONES]);
    expect(
      (await handleFetch(req("/api/domains/z1/rules", "POST", { local: "a b@", action: "inbox" }), env, ctx)).status,
    ).toBe(400);
    expect(
      (await handleFetch(req("/api/domains/z1/rules", "POST", { local: "x", action: "hijack" }), env, ctx)).status,
    ).toBe(400);
  });

  it("503s inbox rules when the worker name is unconfigured", async () => {
    const { env } = makeEnv();
    (env as any).INBOX_WORKER_NAME = undefined;
    recordingFetch([ZONES]);
    const res = await handleFetch(req("/api/domains/z1/rules", "POST", { local: "x", action: "inbox" }), env, ctx);
    expect(res.status).toBe(503);
  });

  it("404s zones outside the account", async () => {
    const { env } = makeEnv();
    recordingFetch([ZONES]);
    const res = await handleFetch(req("/api/domains/zZZ/rules", "POST", { local: "x", action: "drop" }), env, ctx);
    expect(res.status).toBe(404);
  });
});

describe("rule toggle/delete routes", () => {
  it("PATCH validates `enabled` and rides the ownership guard", async () => {
    const { env } = makeEnv();
    recordingFetch([ZONES]);
    const bad = await handleFetch(req("/api/domains/z1/rules/r1", "PATCH", { enabled: "yes" }), env, ctx);
    expect(bad.status).toBe(400);
    const notOurs = await handleFetch(req("/api/domains/zZZ/rules/r1", "PATCH", { enabled: true }), env, ctx);
    expect(notOurs.status).toBe(404);
  });

  it("DELETE removes a managed rule (after read-before-delete guard)", async () => {
    const { env } = makeEnv();
    recordingFetch([
      ZONES,
      {
        match: "/email/routing/rules/r1",
        method: "GET",
        res: () =>
          cf({
            success: true,
            result: {
              id: "r1",
              name: "rule: sales@a.com",
              matchers: [{ type: "literal", field: "to", value: "sales@a.com" }],
              actions: [{ type: "drop" }],
            },
          }),
      },
      { match: "/email/routing/rules/r1", method: "DELETE", res: () => cf({ success: true, result: {} }) },
    ]);
    const res = await handleFetch(req("/api/domains/z1/rules/r1", "DELETE"), env, ctx);
    expect(res.status).toBe(200);
  });

  it("DELETE refuses an unmanaged (foreign-domain) rule with 400", async () => {
    const { env } = makeEnv();
    const calls = recordingFetch([
      ZONES,
      {
        match: "/email/routing/rules/r1",
        method: "GET",
        res: () =>
          cf({
            success: true,
            result: {
              id: "r1",
              matchers: [{ type: "literal", field: "to", value: "x@evil.net" }],
              actions: [{ type: "drop" }],
            },
          }),
      },
    ]);
    const res = await handleFetch(req("/api/domains/z1/rules/r1", "DELETE"), env, ctx);
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("POST /api/destinations", () => {
  it("validates the email shape", async () => {
    const { env } = makeEnv();
    recordingFetch([]);
    const res = await handleFetch(req("/api/destinations", "POST", { email: "not-an-email" }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("registers a destination", async () => {
    const { env } = makeEnv();
    const calls = recordingFetch([
      { match: "/email/routing/addresses", method: "POST", res: () => cf({ success: true, result: {} }) },
    ]);
    const res = await handleFetch(req("/api/destinations", "POST", { email: "new@x.com" }), env, ctx);
    expect(res.status).toBe(200);
    expect(calls[0].body).toEqual({ email: "new@x.com" });
  });
});

describe("/api/domains/:zoneId/settings (forward copy)", () => {
  it("GET returns the overrides and the defaults", async () => {
    const { env } = makeEnv({ domain: "a.com", forward_copy_to: "", display_name: "Acme Inc" });
    recordingFetch([ZONES]);
    const res = await handleFetch(req("/api/domains/z1/settings", "GET"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      forwardCopyTo: "",
      forwardCopyDefault: "alex@example.com",
      displayName: "Acme Inc",
      displayNameDefault: "A",
    });
  });

  it("PATCH rejects an unverified copy destination", async () => {
    const { env, statements } = makeEnv();
    recordingFetch([
      ZONES,
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: false }, 404) },
      { match: "/email/routing/rules", res: () => cf({ success: true, result: [] }) },
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [{ email: "v@x.com", verified: null }] }) },
      { match: "/email/routing", res: () => cf({ success: false }, 404) },
      { match: "/dns_records", res: () => cf({ success: true, result: [] }) },
      { match: "/email/sending/subdomains", res: () => cf({ success: true, result: [] }) },
    ]);
    const res = await handleFetch(req("/api/domains/z1/settings", "PATCH", { forwardCopyTo: "v@x.com" }), env, ctx);
    expect(res.status).toBe(400);
    expect(statements.some((s) => /INSERT INTO domains/i.test(s.sql))).toBe(false);
  });

  it("PATCH accepts off ('') and default (null) without touching CF", async () => {
    const { env, statements } = makeEnv();
    recordingFetch([ZONES]);
    expect((await handleFetch(req("/api/domains/z1/settings", "PATCH", { forwardCopyTo: "" }), env, ctx)).status).toBe(200);
    expect((await handleFetch(req("/api/domains/z1/settings", "PATCH", { forwardCopyTo: null }), env, ctx)).status).toBe(200);
    const upserts = statements.filter((s) => /INSERT INTO domains/i.test(s.sql));
    expect(upserts).toHaveLength(2);
    expect(upserts[0].params[1]).toBe("");
    expect(upserts[1].params[1]).toBeNull();
  });

  it("PATCH saves a sanitized sender name; ''/whitespace clears it to NULL", async () => {
    const { env, statements } = makeEnv();
    recordingFetch([ZONES]);
    expect(
      (await handleFetch(req("/api/domains/z1/settings", "PATCH", { displayName: " Acme\r\nInc " }), env, ctx)).status,
    ).toBe(200);
    expect(
      (await handleFetch(req("/api/domains/z1/settings", "PATCH", { displayName: "   " }), env, ctx)).status,
    ).toBe(200);
    expect(
      (await handleFetch(req("/api/domains/z1/settings", "PATCH", { displayName: null }), env, ctx)).status,
    ).toBe(200);
    const writes = statements.filter((s) => /display_name/i.test(s.sql) && /INSERT INTO domains/i.test(s.sql));
    expect(writes).toHaveLength(3);
    expect(writes[0].params[1]).toBe("Acme Inc"); // CR/LF collapsed — no header injection
    expect(writes[1].params[1]).toBeNull();
    expect(writes[2].params[1]).toBeNull();
  });

  it("PATCH updates both fields together, and validates each", async () => {
    const { env, statements } = makeEnv();
    recordingFetch([ZONES]);
    const res = await handleFetch(
      req("/api/domains/z1/settings", "PATCH", { forwardCopyTo: "", displayName: "Acme" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const writes = statements.filter((s) => /INSERT INTO domains/i.test(s.sql));
    expect(writes).toHaveLength(2);
    expect((await handleFetch(req("/api/domains/z1/settings", "PATCH", { displayName: 7 }), env, ctx)).status).toBe(400);
    expect((await handleFetch(req("/api/domains/z1/settings", "PATCH", {}), env, ctx)).status).toBe(400);
  });
});

describe("forwardCopyFor", () => {
  const dbWith = (row: Record<string, unknown> | null, throws = false) =>
    ({
      DB: {
        prepare() {
          return {
            bind() {
              return {
                first: async () => {
                  if (throws) throw new Error("no such table");
                  return row;
                },
              };
            },
          };
        },
      },
    }) as any;

  it("override address wins; '' disables; NULL/missing row falls back to global", async () => {
    expect(await forwardCopyFor(dbWith({ forward_copy_to: "x@y.com" }), "a.com", "g@d.com")).toBe("x@y.com");
    expect(await forwardCopyFor(dbWith({ forward_copy_to: "" }), "a.com", "g@d.com")).toBeUndefined();
    expect(await forwardCopyFor(dbWith({ forward_copy_to: null }), "a.com", "g@d.com")).toBe("g@d.com");
    expect(await forwardCopyFor(dbWith(null), "a.com", "g@d.com")).toBe("g@d.com");
    expect(await forwardCopyFor(dbWith(null, true), "a.com", "g@d.com")).toBe("g@d.com");
    expect(await forwardCopyFor(dbWith(null), "a.com", undefined)).toBeUndefined();
  });
});
