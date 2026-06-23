import { describe, it, expect, vi, afterEach } from "vitest";
import { handleFetch, type Env } from "../index";

// Route-level tests for the one-click onboarding endpoints:
//   POST /api/domains/:zoneId/receiving  (enable routing where safe + catch-all)
//   POST /api/domains/:zoneId/sending    (Email Sending onboarding + DNS ensure)
// CF API calls are stubbed via global fetch; the D1 stub records the registry
// upserts (CREATE TABLE bootstrap + INSERT ... ON CONFLICT).

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

/** D1 stub that records every prepared statement + its binds. */
function makeEnv() {
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
        first: async () => null,
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
  } as unknown as Env;
  return { env, statements };
}

function post(path: string, body: unknown) {
  return new Request(`https://inbox.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
    body: JSON.stringify(body),
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

describe("POST /api/domains/:zoneId/receiving", () => {
  it("routing already active: just points the catch-all at the Worker and records the mode", async () => {
    const { env, statements } = makeEnv();
    const calls = recordingFetch([
      ZONES,
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: true, result: {} }) },
      { match: "/email/routing", res: () => cf({ success: true, result: { enabled: true, status: "ready" } }) },
    ]);
    const res = await handleFetch(post("/api/domains/z1/receiving", { mode: "inbox" }), env, ctx);
    expect(res.status).toBe(200);
    // No enable call, no DNS reads.
    expect(calls.some((c) => c.url.includes("/email/routing/enable"))).toBe(false);
    const put = calls.find((c) => c.method === "PUT");
    expect(put!.body).toMatchObject({ actions: [{ type: "worker", value: ["mailcove"] }] });
    // Registry upsert recorded (after the CREATE TABLE bootstrap).
    const upsert = statements.find((s) => /INSERT INTO domains/i.test(s.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.params[0]).toBe("a.com");
    expect(upsert!.params[3]).toBe("inbox"); // receive_mode
  });

  it("routing off + clean MX: enables routing first, then sets the catch-all", async () => {
    const { env } = makeEnv();
    const calls = recordingFetch([
      ZONES,
      { match: "/email/routing/enable", res: () => cf({ success: true, result: { enabled: true } }) },
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: true, result: {} }) },
      { match: "/email/routing", res: () => cf({ success: false }, 404) },
      { match: "/dns_records", res: () => cf({ success: true, result: [] }) },
    ]);
    const res = await handleFetch(post("/api/domains/z1/receiving", { mode: "inbox" }), env, ctx);
    expect(res.status).toBe(200);
    const order = calls.map((c) => c.url.replace(/^.*\/zones\/z1/, ""));
    expect(order.some((u) => u.includes("/email/routing/enable"))).toBe(true);
    expect(calls.findIndex((c) => c.url.includes("/enable"))).toBeLessThan(
      calls.findIndex((c) => c.method === "PUT"),
    );
  });

  it("REFUSES (409, zero writes) when the apex MX points at another provider", async () => {
    const { env, statements } = makeEnv();
    const calls = recordingFetch([
      ZONES,
      { match: "/email/routing", res: () => cf({ success: false }, 404) },
      {
        match: "/dns_records",
        res: () => cf({ success: true, result: [{ name: "a.com", content: "aspmx.l.google.com", priority: 1, type: "MX" }] }),
      },
    ]);
    const res = await handleFetch(post("/api/domains/z1/receiving", { mode: "inbox" }), env, ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/another provider/i);
    // No mutating CF call, no registry write.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(statements.some((s) => /INSERT INTO domains/i.test(s.sql))).toBe(false);
  });

  it("forward mode rides the verified-destination check (unverified → 400)", async () => {
    const { env } = makeEnv();
    recordingFetch([
      ZONES,
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [{ email: "me@x.com", verified: null }] }) },
      { match: "/email/routing", res: () => cf({ success: true, result: { enabled: true, status: "ready" } }) },
    ]);
    const res = await handleFetch(
      post("/api/domains/z1/receiving", { mode: "forward", forwardTo: "me@x.com" }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("validates mode and zone", async () => {
    const { env } = makeEnv();
    recordingFetch([ZONES]);
    expect((await handleFetch(post("/api/domains/z1/receiving", { mode: "hijack" }), env, ctx)).status).toBe(400);
    expect((await handleFetch(post("/api/domains/zZZ/receiving", { mode: "inbox" }), env, ctx)).status).toBe(404);
  });

  it("FAILS CLOSED (502, zero writes) when the MX records can't be read", async () => {
    const { env, statements } = makeEnv();
    const calls = recordingFetch([
      ZONES,
      { match: "/email/routing", res: () => cf({ success: false }, 404) },
      { match: "/dns_records", res: () => cf({ success: false }, 500) },
    ]);
    const res = await handleFetch(post("/api/domains/z1/receiving", { mode: "inbox" }), env, ctx);
    expect(res.status).toBe(502);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(statements.some((s) => /INSERT INTO domains/i.test(s.sql))).toBe(false);
  });

  it("FAILS CLOSED (502, zero writes) when the routing state can't be read", async () => {
    const { env } = makeEnv();
    const calls = recordingFetch([ZONES, { match: "/email/routing", res: () => cf({ success: false }, 500) }]);
    const res = await handleFetch(post("/api/domains/z1/receiving", { mode: "inbox" }), env, ctx);
    expect(res.status).toBe(502);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses (409) a half-configured zone (enabled but not ready) instead of re-enabling", async () => {
    const { env } = makeEnv();
    const calls = recordingFetch([
      ZONES,
      { match: "/email/routing", res: () => cf({ success: true, result: { enabled: true, status: "misconfigured" } }) },
      { match: "/dns_records", res: () => cf({ success: true, result: [] }) },
    ]);
    const res = await handleFetch(post("/api/domains/z1/receiving", { mode: "inbox" }), env, ctx);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toMatch(/review/i);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("503s for mode=inbox when INBOX_WORKER_NAME is not configured (no guessing)", async () => {
    const { env } = makeEnv();
    (env as any).INBOX_WORKER_NAME = undefined;
    recordingFetch([ZONES]);
    const res = await handleFetch(post("/api/domains/z1/receiving", { mode: "inbox" }), env, ctx);
    expect(res.status).toBe(503);
  });
});

describe("POST /api/domains/:zoneId/sending", () => {
  it("onboards the APEX by default, ensures DNS, and registers the identity", async () => {
    const { env, statements } = makeEnv();
    const calls = recordingFetch([
      ZONES,
      {
        match: "/email/sending/subdomains",
        method: "POST",
        res: () => cf({ success: true, result: { id: "sid1", name: "a.com", enabled: true } }),
      },
      {
        match: "/email/sending/subdomains/sid1/dns",
        res: () =>
          cf({
            success: true,
            result: [
              { name: "cf-bounce.a.com", type: "MX", content: "route1.mx.cloudflare.net.", priority: 1, ttl: 1 },
              { name: "_dmarc.a.com", type: "TXT", content: '"v=DMARC1; p=reject;"', ttl: 1 },
            ],
          }),
      },
      { match: "/dns_records?", method: "GET", res: () => cf({ success: true, result: [] }) },
      { match: "/dns_records", method: "POST", res: () => cf({ success: true, result: { id: "r" } }) },
    ]);
    const res = await handleFetch(post("/api/domains/z1/sending", {}), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sendingDomain).toBe("a.com");
    expect(body.dns).toEqual({ created: 2, skipped: 0, errors: [] });
    expect(calls.find((c) => c.method === "POST" && c.url.includes("/email/sending"))!.body).toEqual({
      name: "a.com",
    });
    const upsert = statements.find((s) => /INSERT INTO domains/i.test(s.sql));
    expect(upsert!.params[0]).toBe("a.com");
    expect(upsert!.params[2]).toBe("a.com"); // sending_domain = apex
  });

  it("variant=subdomain onboards send.<apex> instead", async () => {
    const { env, statements } = makeEnv();
    recordingFetch([
      ZONES,
      {
        match: "/email/sending/subdomains",
        method: "POST",
        res: () => cf({ success: true, result: { id: "sid2", name: "send.a.com", enabled: true } }),
      },
      { match: "/email/sending/subdomains/sid2/dns", res: () => cf({ success: true, result: [] }) },
      { match: "/dns_records?", method: "GET", res: () => cf({ success: true, result: [] }) },
    ]);
    const res = await handleFetch(post("/api/domains/z1/sending", { variant: "subdomain" }), env, ctx);
    expect(res.status).toBe(200);
    const upsert = statements.find((s) => /INSERT INTO domains/i.test(s.sql));
    expect(upsert!.params[2]).toBe("send.a.com");
  });

  it("propagates onboarding failure as 502 with the CF message", async () => {
    const { env, statements } = makeEnv();
    recordingFetch([
      ZONES,
      {
        match: "/email/sending/subdomains",
        method: "POST",
        res: () => cf({ success: false, errors: [{ code: 9999, message: "domain limit reached" }] }),
      },
      { match: "/email/sending/subdomains", method: "GET", res: () => cf({ success: true, result: [] }) },
      { match: "/dns_records", res: () => cf({ success: true, result: [] }) },
    ]);
    const res = await handleFetch(post("/api/domains/z1/sending", {}), env, ctx);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toBe("domain limit reached");
    expect(statements.some((s) => /INSERT INTO domains/i.test(s.sql))).toBe(false);
  });

  it("fails closed (502) and does NOT register the identity when DNS reconciliation fails", async () => {
    const { env, statements } = makeEnv();
    recordingFetch([
      ZONES,
      {
        match: "/email/sending/subdomains",
        method: "POST",
        res: () => cf({ success: true, result: { id: "sid1", name: "a.com", enabled: true } }),
      },
      { match: "/email/sending/subdomains/sid1/dns", res: () => cf({ success: false }, 500) },
      { match: "/dns_records", res: () => cf({ success: true, result: [] }) },
    ]);
    const res = await handleFetch(post("/api/domains/z1/sending", {}), env, ctx);
    expect(res.status).toBe(502);
    expect(statements.some((s) => /INSERT INTO domains/i.test(s.sql))).toBe(false);
  });

  it("never creates a DMARC policy for a domain whose mail is hosted elsewhere", async () => {
    const { env, statements } = makeEnv();
    const calls = recordingFetch([
      ZONES,
      {
        match: "/email/sending/subdomains",
        method: "POST",
        res: () => cf({ success: true, result: { id: "sid1", name: "a.com", enabled: true } }),
      },
      {
        match: "/email/sending/subdomains/sid1/dns",
        res: () =>
          cf({
            success: true,
            result: [
              { name: "cf-bounce.a.com", type: "MX", content: "route1.mx.cloudflare.net.", priority: 1, ttl: 1 },
              { name: "_dmarc.a.com", type: "TXT", content: '"v=DMARC1; p=reject;"', ttl: 1 },
            ],
          }),
      },
      {
        // Google MX on the apex → sending is allowed, DMARC creation is not.
        match: "/dns_records?type=MX",
        res: () => cf({ success: true, result: [{ name: "a.com", content: "aspmx.l.google.com", priority: 1 }] }),
      },
      { match: "/dns_records?", method: "GET", res: () => cf({ success: true, result: [] }) },
      { match: "/dns_records", method: "POST", res: () => cf({ success: true, result: { id: "r" } }) },
    ]);
    const res = await handleFetch(post("/api/domains/z1/sending", {}), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.dmarcSkipped).toBe(true);
    expect(body.dns).toEqual({ created: 1, skipped: 1, errors: [] });
    const dmarcPosts = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/dns_records") && (c.body as any)?.name?.includes("_dmarc"),
    );
    expect(dmarcPosts).toHaveLength(0);
    // Still registered (sending works; DMARC just isn't our call to make).
    expect(statements.some((s) => /INSERT INTO domains/i.test(s.sql))).toBe(true);
  });
});
