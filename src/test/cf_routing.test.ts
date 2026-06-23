import { describe, it, expect, vi, afterEach } from "vitest";
import { listDomains, getDomainDetail, setCatchAll, zoneInAccount, CfNotConfigured, type CfEnv } from "../cf_routing";

const ACCT = "acct123";
const env: CfEnv = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: ACCT };

/** Build a CF API JSON Response. */
function cf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Stub global fetch with a URL→Response router. Each entry is matched by
 * substring; the first match wins. Unmatched URLs throw (catches typos).
 */
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

describe("listDomains", () => {
  it("pages through zones and maps them to summaries", async () => {
    const fetchMock = routeFetch([
      {
        match: "/zones?",
        res: () =>
          cf({
            success: true,
            result: [
              { id: "z1", name: "b.com", status: "active", paused: false },
              { id: "z2", name: "a.com", status: "active", paused: true },
            ],
            result_info: { page: 1, total_pages: 1 },
          }),
      },
    ]);
    const out = await listDomains(env);
    expect(out).toEqual([
      { zoneId: "z1", name: "b.com", zoneStatus: "active", paused: false },
      { zoneId: "z2", name: "a.com", zoneStatus: "active", paused: true },
    ]);
    // Single page → exactly one zones call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows pagination across multiple pages", async () => {
    let page = 0;
    routeFetch([
      {
        match: "/zones?",
        res: () => {
          page++;
          return cf({
            success: true,
            result: [{ id: `z${page}`, name: `d${page}.com`, status: "active" }],
            result_info: { page, total_pages: 2 },
          });
        },
      },
    ]);
    const out = await listDomains(env);
    expect(out.map((d) => d.zoneId)).toEqual(["z1", "z2"]);
  });

  it("throws CfNotConfigured when the token is missing", async () => {
    await expect(listDomains({ CF_ACCOUNT_ID: ACCT })).rejects.toBeInstanceOf(CfNotConfigured);
  });
});

describe("getDomainDetail", () => {
  it("aggregates routing settings, custom rules, catch-all, destinations, and MX", async () => {
    routeFetch([
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: true, result: { enabled: true, actions: [{ type: "forward", value: ["me@dest.com"] }] } }) },
      { match: "/email/routing/rules", res: () => cf({ success: true, result: [
        { id: "r1", name: "sales", enabled: true, matchers: [{ type: "literal", field: "to", value: "sales@a.com" }], actions: [{ type: "forward", value: ["team@dest.com"] }] },
        // a catch-all-style rule (matcher type "all") must be filtered OUT of custom rules
        { id: "rAll", name: "catchall-dupe", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "drop" }] },
      ] }) },
      // NOTE: more-specific paths must precede the bare "/email/routing" (the
      // router matches by first substring hit).
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [{ email: "me@dest.com", verified: "2024-01-01" }, { email: "x@dest.com", verified: null }] }) },
      { match: "/email/routing", res: () => cf({ success: true, result: { enabled: true, status: "ready" } }) },
      { match: "/dns_records", res: () => cf({ success: true, result: [{ name: "a.com", content: "route1.mx.cloudflare.net", priority: 13 }] }) },
    ]);
    const d = await getDomainDetail(env, "z1", "a.com");
    expect(d.name).toBe("a.com");
    expect(d.routing).toEqual({ enabled: true, status: "ready" });
    // Only the non-"all" custom rule survives.
    expect(d.rules).toHaveLength(1);
    expect(d.rules[0].name).toBe("sales");
    expect(d.catchAll?.enabled).toBe(true);
    expect(d.destinations).toEqual([
      { email: "me@dest.com", verified: true },
      { email: "x@dest.com", verified: false },
    ]);
    expect(d.mx).toEqual([{ name: "a.com", content: "route1.mx.cloudflare.net", priority: 13 }]);
  });

  it("degrades gracefully: a failing sub-endpoint yields a safe empty/null, not a throw", async () => {
    routeFetch([
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: false, errors: [{ message: "boom" }] }, 500) },
      { match: "/email/routing/rules", res: () => cf({ success: false }, 500) },
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [] }) },
      { match: "/email/routing", res: () => cf({ success: true, result: { enabled: false, status: "misconfigured" } }) },
      { match: "/dns_records", res: () => cf({ success: false }, 500) },
    ]);
    const d = await getDomainDetail(env, "z1", "a.com");
    expect(d.routing).toEqual({ enabled: false, status: "misconfigured" });
    expect(d.rules).toEqual([]);
    expect(d.catchAll).toBeNull();
    expect(d.mx).toEqual([]);
  });

  it("distinguishes a transient settings failure (5xx) from 'not provisioned': status 'unknown', not null", async () => {
    routeFetch([
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: false }, 404) },
      { match: "/email/routing/rules", res: () => cf({ success: true, result: [] }) },
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [] }) },
      // The settings endpoint itself errors (CF 5xx) — couldn't read, not absent.
      { match: "/email/routing", res: () => cf({ success: false }, 500) },
      { match: "/dns_records", res: () => cf({ success: true, result: [] }) },
    ]);
    const d = await getDomainDetail(env, "z1", "a.com");
    expect(d.routing).toEqual({ enabled: false, status: "unknown" });
  });

  it("returns routing: null when Email Routing is not provisioned (404)", async () => {
    routeFetch([
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: false }, 404) },
      { match: "/email/routing/rules", res: () => cf({ success: false }, 404) },
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [] }) },
      { match: "/email/routing", res: () => cf({ success: false, errors: [{ code: 1001 }] }, 404) },
      { match: "/dns_records", res: () => cf({ success: true, result: [] }) },
    ]);
    const d = await getDomainDetail(env, "z9", "new.com");
    expect(d.routing).toBeNull();
    expect(d.catchAll).toBeNull();
  });
});

/** A fetch mock that records method + parsed body and returns a fixed envelope. */
function recordingFetch(routes: { match: string; res: () => Response }[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`unrouted fetch: ${url}`);
    return hit.res();
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("zoneInAccount", () => {
  it("is true only for a zone the account lists", async () => {
    routeFetch([
      { match: "/zones?", res: () => cf({ success: true, result: [{ id: "z1", name: "a.com", status: "active" }], result_info: { page: 1, total_pages: 1 } }) },
    ]);
    expect(await zoneInAccount(env, "z1")).toBe(true);
    routeFetch([
      { match: "/zones?", res: () => cf({ success: true, result: [{ id: "z1", name: "a.com", status: "active" }], result_info: { page: 1, total_pages: 1 } }) },
    ]);
    expect(await zoneInAccount(env, "zX")).toBe(false);
  });
});

describe("setCatchAll", () => {
  it("forwards ONLY to a verified destination (PUT catch_all)", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [{ email: "me@dest.com", verified: "2024" }] }) },
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: true, result: {} }) },
    ]);
    const r = await setCatchAll(env, "z1", { action: "forward", forwardTo: "me@dest.com" });
    expect(r.ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put!.url).toContain("/email/routing/rules/catch_all");
    expect(put!.body).toMatchObject({ actions: [{ type: "forward", value: ["me@dest.com"] }] });
  });

  it("refuses to forward to an UNVERIFIED / unknown address (no PUT issued)", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [{ email: "me@dest.com", verified: null }] }) },
    ]);
    const r = await setCatchAll(env, "z1", { action: "forward", forwardTo: "me@dest.com" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a verified/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("sets drop without needing a destination", async () => {
    const calls = recordingFetch([{ match: "/email/routing/rules/catch_all", res: () => cf({ success: true, result: {} }) }]);
    const r = await setCatchAll(env, "z1", { action: "drop" });
    expect(r.ok).toBe(true);
    expect(calls[0].body).toMatchObject({ actions: [{ type: "drop" }] });
  });
});
