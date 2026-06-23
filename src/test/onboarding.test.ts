import { describe, it, expect, vi, afterEach } from "vitest";
import {
  hasForeignApexMx,
  enableRouting,
  onboardSending,
  ensureDnsRecords,
  getSendingDomains,
  setCatchAll,
  findZone,
  type CfEnv,
  type MxRecord,
  type DnsRecord,
} from "../cf_routing";

const env: CfEnv = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acct123" };

function cf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** fetch stub recording method+body, routed by URL substring (first match wins). */
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

const mx = (name: string, content: string): MxRecord => ({ name, content, priority: 10 });

describe("hasForeignApexMx", () => {
  it("is true for apex MX pointing at another provider (Google)", () => {
    expect(hasForeignApexMx([mx("a.com", "aspmx.l.google.com")], "a.com")).toBe(true);
  });
  it("is false for Cloudflare Email Routing MX (route*/named hosts)", () => {
    expect(hasForeignApexMx([mx("a.com", "route1.mx.cloudflare.net")], "a.com")).toBe(false);
    expect(hasForeignApexMx([mx("a.com", "amir.mx.cloudflare.net")], "a.com")).toBe(false);
  });
  it("ignores subdomain MX (cf-bounce etc.) and normalizes trailing dots/case", () => {
    expect(hasForeignApexMx([mx("cf-bounce.a.com", "route1.mx.cloudflare.net")], "a.com")).toBe(false);
    expect(hasForeignApexMx([mx("mg.a.com", "mxa.mailgun.org")], "a.com")).toBe(false);
    expect(hasForeignApexMx([mx("A.com", "Route1.MX.Cloudflare.NET.")], "a.com")).toBe(false);
  });
  it("is false with no MX at all", () => {
    expect(hasForeignApexMx([], "a.com")).toBe(false);
  });
});

describe("enableRouting", () => {
  it("POSTs the enable endpoint and reports success", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/enable", res: () => cf({ success: true, result: { enabled: true, status: "ready" } }) },
    ]);
    const r = await enableRouting(env, "z1");
    expect(r.ok).toBe(true);
    expect(calls[0].method).toBe("POST");
  });
  it("surfaces the CF error message on failure", async () => {
    recordingFetch([
      { match: "/email/routing/enable", res: () => cf({ success: false, errors: [{ message: "nope" }] }) },
    ]);
    const r = await enableRouting(env, "z1");
    expect(r).toEqual({ ok: false, error: "nope" });
  });
});

describe("onboardSending", () => {
  it("creates the sending domain and returns its id", async () => {
    const calls = recordingFetch([
      {
        match: "/email/sending/subdomains",
        method: "POST",
        res: () => cf({ success: true, result: { id: "sid1", name: "a.com", enabled: true } }),
      },
    ]);
    const r = await onboardSending(env, "z1", "a.com");
    expect(r).toEqual({ ok: true, id: "sid1" });
    expect(calls[0].body).toEqual({ name: "a.com" });
  });

  it("is idempotent: 'Subdomain already exists' (2040) resolves the existing id", async () => {
    recordingFetch([
      {
        match: "/email/sending/subdomains",
        method: "POST",
        res: () => cf({ success: false, errors: [{ code: 2040, message: "Subdomain already exists" }] }),
      },
      {
        match: "/email/sending/subdomains",
        method: "GET",
        res: () => cf({ success: true, result: [{ id: "sid9", name: "a.com", enabled: true }] }),
      },
    ]);
    const r = await onboardSending(env, "z1", "a.com");
    expect(r).toEqual({ ok: true, id: "sid9" });
  });

  it("fails closed on other errors", async () => {
    recordingFetch([
      {
        match: "/email/sending/subdomains",
        method: "POST",
        res: () => cf({ success: false, errors: [{ code: 9999, message: "limit reached" }] }),
      },
    ]);
    const r = await onboardSending(env, "z1", "a.com");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("limit reached");
  });
});

describe("ensureDnsRecords", () => {
  const expected: DnsRecord[] = [
    { name: "cf-bounce.a.com", type: "MX", content: "route1.mx.cloudflare.net.", priority: 37, ttl: 1 },
    { name: "cf-bounce.a.com", type: "MX", content: "route2.mx.cloudflare.net.", priority: 83, ttl: 1 },
    { name: "cf-bounce.a.com", type: "TXT", content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"', ttl: 1 },
    { name: "_dmarc.a.com", type: "TXT", content: '"v=DMARC1; p=reject;"', ttl: 1 },
  ];

  it("creates every missing record (CREATE-only)", async () => {
    const calls = recordingFetch([
      { match: "/dns_records?", method: "GET", res: () => cf({ success: true, result: [] }) },
      { match: "/dns_records", method: "POST", res: () => cf({ success: true, result: { id: "r" } }) },
    ]);
    const r = await ensureDnsRecords(env, "z1", expected);
    expect(r).toEqual({ created: 4, skipped: 0, errors: [] });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(4);
    // MX carries priority; TXT content is unquoted for the DNS API.
    expect(posts[0].body).toMatchObject({ type: "MX", priority: 37 });
    expect(posts[2].body).toMatchObject({ type: "TXT", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" });
    // Never updates or deletes.
    expect(calls.every((c) => c.method === "GET" || c.method === "POST")).toBe(true);
  });

  it("skips records that already exist (MX matched by content, TXT by name)", async () => {
    const calls = recordingFetch([
      {
        match: "/dns_records?",
        method: "GET",
        res: () =>
          cf({
            success: true,
            result: [
              { name: "cf-bounce.a.com", type: "MX", content: "route1.mx.cloudflare.net" },
              { name: "cf-bounce.a.com", type: "TXT", content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' },
            ],
          }),
      },
      { match: "/dns_records", method: "POST", res: () => cf({ success: true, result: { id: "r" } }) },
    ]);
    const r = await ensureDnsRecords(env, "z1", expected);
    // route2 MX + _dmarc created; route1 MX + SPF TXT skipped.
    expect(r.created).toBe(2);
    expect(r.skipped).toBe(2);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("NEVER touches an existing _dmarc policy, whatever its content", async () => {
    const calls = recordingFetch([
      {
        match: "/dns_records?",
        method: "GET",
        res: () =>
          cf({
            success: true,
            result: [{ name: "_dmarc.a.com", type: "TXT", content: '"v=DMARC1; p=none; rua=mailto:x@a.com"' }],
          }),
      },
      { match: "/dns_records", method: "POST", res: () => cf({ success: true, result: { id: "r" } }) },
    ]);
    const r = await ensureDnsRecords(env, "z1", [expected[3]]);
    expect(r).toEqual({ created: 0, skipped: 1, errors: [] });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("THROWS (fail closed) when the zone's records can't be listed", async () => {
    recordingFetch([{ match: "/dns_records?", method: "GET", res: () => cf({ success: false }, 500) }]);
    await expect(ensureDnsRecords(env, "z1", expected)).rejects.toThrow();
  });

  it("skipDmarc skips _dmarc creation entirely (externally-hosted mail)", async () => {
    const calls = recordingFetch([
      { match: "/dns_records?", method: "GET", res: () => cf({ success: true, result: [] }) },
      { match: "/dns_records", method: "POST", res: () => cf({ success: true, result: { id: "r" } }) },
    ]);
    const r = await ensureDnsRecords(env, "z1", expected, { skipDmarc: true });
    expect(r.created).toBe(3);
    expect(r.skipped).toBe(1);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.some((c) => (c.body as any)?.name?.includes("_dmarc"))).toBe(false);
  });

  it("paginates the zone's records so page-2 records are still seen", async () => {
    let page = 0;
    const calls = recordingFetch([
      {
        match: "/dns_records?",
        method: "GET",
        res: () => {
          page++;
          return cf({
            success: true,
            result:
              page === 1
                ? [{ name: "filler.a.com", type: "A", content: "1.2.3.4" }]
                : [{ name: "_dmarc.a.com", type: "TXT", content: '"v=DMARC1; p=none;"' }],
            result_info: { page, total_pages: 2 },
          });
        },
      },
      { match: "/dns_records", method: "POST", res: () => cf({ success: true, result: { id: "r" } }) },
    ]);
    const r = await ensureDnsRecords(env, "z1", [expected[3]]);
    // The page-2 _dmarc is seen → nothing created.
    expect(r).toEqual({ created: 0, skipped: 1, errors: [] });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("collects per-record create errors without aborting the rest", async () => {
    let n = 0;
    recordingFetch([
      { match: "/dns_records?", method: "GET", res: () => cf({ success: true, result: [] }) },
      {
        match: "/dns_records",
        method: "POST",
        res: () => cf(++n === 1 ? { success: false, errors: [{ message: "boom" }] } : { success: true, result: {} }),
      },
    ]);
    const r = await ensureDnsRecords(env, "z1", expected.slice(0, 2));
    expect(r.created).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("boom");
  });
});

describe("setCatchAll worker action", () => {
  it("points the catch-all at the configured Worker", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/rules/catch_all", res: () => cf({ success: true, result: {} }) },
    ]);
    const r = await setCatchAll(env, "z1", { action: "worker", workerName: "mailcove" });
    expect(r.ok).toBe(true);
    expect(calls[0].body).toMatchObject({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: ["mailcove"] }],
    });
  });
  it("refuses an empty worker name", async () => {
    const calls = recordingFetch([]);
    const r = await setCatchAll(env, "z1", { action: "worker" });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("getSendingDomains / findZone", () => {
  it("parses sending domains and degrades to [] on failure", async () => {
    recordingFetch([
      {
        match: "/email/sending/subdomains",
        res: () => cf({ success: true, result: [{ id: "s1", name: "send.a.com", enabled: true }] }),
      },
    ]);
    expect(await getSendingDomains(env, "z1")).toEqual([{ id: "s1", name: "send.a.com", enabled: true }]);
    recordingFetch([{ match: "/email/sending/subdomains", res: () => cf({ success: false }, 500) }]);
    expect(await getSendingDomains(env, "z1")).toEqual([]);
  });

  it("findZone returns the matching summary or null", async () => {
    recordingFetch([
      {
        match: "/zones?",
        res: () =>
          cf({
            success: true,
            result: [{ id: "z1", name: "a.com", status: "active" }],
            result_info: { page: 1, total_pages: 1 },
          }),
      },
    ]);
    expect(await findZone(env, "z1")).toMatchObject({ zoneId: "z1", name: "a.com" });
    recordingFetch([
      {
        match: "/zones?",
        res: () =>
          cf({
            success: true,
            result: [{ id: "z1", name: "a.com", status: "active" }],
            result_info: { page: 1, total_pages: 1 },
          }),
      },
    ]);
    expect(await findZone(env, "zX")).toBeNull();
  });
});
