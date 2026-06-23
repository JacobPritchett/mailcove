import { describe, it, expect, vi, afterEach } from "vitest";
import { handleFetch, type Env } from "../index";

const ctx = {} as ExecutionContext;

function cf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routeFetch(routes: { match: string; res: () => Response }[]) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`unrouted fetch: ${url}`);
    return hit.res();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

function makeEnv(opts: { token?: string; cfToken?: string | undefined } = {}): Env {
  return {
    DB: {} as unknown,
    MAILSTORE: {} as unknown,
    AUTH_TOKEN: opts.token ?? "secret-token",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    CF_API_TOKEN: "cfToken" in opts ? opts.cfToken : "cf-tok",
    CF_ACCOUNT_ID: "acct123",
  } as unknown as Env;
}

function get(path: string, token = "secret-token") {
  return new Request(`https://inbox.example.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("GET /api/domains", () => {
  it("returns the zone list", async () => {
    routeFetch([
      { match: "/zones?", res: () => cf({ success: true, result: [{ id: "z1", name: "a.com", status: "active" }], result_info: { page: 1, total_pages: 1 } }) },
    ]);
    const res = await handleFetch(get("/api/domains"), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: { name: string }[] };
    expect(body.domains).toEqual([{ zoneId: "z1", name: "a.com", zoneStatus: "active", paused: false }]);
  });

  it("503s when CF_API_TOKEN is not configured", async () => {
    const res = await handleFetch(get("/api/domains"), makeEnv({ cfToken: undefined }), ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not configured/i);
  });

  it("requires auth", async () => {
    const res = await handleFetch(get("/api/domains", "wrong"), makeEnv(), ctx);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/domains/:zoneId", () => {
  it("returns routing detail for one zone", async () => {
    routeFetch([
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: true, result: { enabled: true, actions: [{ type: "forward", value: ["me@dest.com"] }] } }) },
      { match: "/email/routing/rules", res: () => cf({ success: true, result: [] }) },
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [] }) },
      { match: "/email/routing", res: () => cf({ success: true, result: { enabled: true, status: "ready" } }) },
      { match: "/dns_records", res: () => cf({ success: true, result: [] }) },
    ]);
    const res = await handleFetch(get("/api/domains/z1?name=a.com"), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { detail: { name: string; routing: unknown; catchAll: { enabled: boolean } } };
    expect(body.detail.name).toBe("a.com");
    expect(body.detail.routing).toEqual({ enabled: true, status: "ready" });
    expect(body.detail.catchAll.enabled).toBe(true);
  });

  it("requires auth", async () => {
    const res = await handleFetch(get("/api/domains/z1?name=a.com", "wrong"), makeEnv(), ctx);
    expect(res.status).toBe(401);
  });
});

function send(path: string, method: string, body: unknown, token = "secret-token") {
  return new Request(`https://inbox.example.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Catch-all writes call zoneInAccount (lists zones) before mutating, so these
// mocks include a "/zones?" route returning z1 as an owned zone.
const ownedZone = { match: "/zones?", res: () => cf({ success: true, result: [{ id: "z1", name: "a.com", status: "active" }], result_info: { page: 1, total_pages: 1 } }) };

describe("PUT /api/domains/:zoneId/catch-all", () => {
  it("forwards to a verified destination on an owned zone", async () => {
    routeFetch([
      ownedZone,
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [{ email: "me@dest.com", verified: "2024" }] }) },
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: true, result: {} }) },
    ]);
    const res = await handleFetch(send("/api/domains/z1/catch-all", "PUT", { action: "forward", forwardTo: "me@dest.com" }), makeEnv(), ctx);
    expect(res.status).toBe(200);
  });
  it("404s a zone that isn't in this account (ownership guard)", async () => {
    routeFetch([ownedZone]);
    const res = await handleFetch(send("/api/domains/zX/catch-all", "PUT", { action: "drop" }), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });
  it("400s an unverified forward target", async () => {
    routeFetch([
      ownedZone,
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [{ email: "me@dest.com", verified: null }] }) },
    ]);
    const res = await handleFetch(send("/api/domains/z1/catch-all", "PUT", { action: "forward", forwardTo: "me@dest.com" }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
  it("400s an invalid action", async () => {
    const res = await handleFetch(send("/api/domains/z1/catch-all", "PUT", { action: "nuke" }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
  it("requires auth", async () => {
    const res = await handleFetch(send("/api/domains/z1/catch-all", "PUT", { action: "drop" }, "nope"), makeEnv(), ctx);
    expect(res.status).toBe(401);
  });
});
