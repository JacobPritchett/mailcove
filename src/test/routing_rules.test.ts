import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createRule,
  setRuleEnabled,
  deleteRule,
  createDestination,
  setCatchAll,
  type CfEnv,
} from "../cf_routing";

const env: CfEnv = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acct123" };

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

// Minimal D1 stand-in backing the managed-rule registry. INSERT adds, DELETE
// removes, the (zone_id, rule_id) SELECT answers from the same set.
function fakeDB(registered = new Set<string>()) {
  const stmt = (sql: string) => ({
    _args: [] as string[],
    bind(...args: unknown[]) {
      this._args = args as string[];
      return this;
    },
    async first<T>() {
      const [zone, rule] = this._args;
      return (registered.has(`${zone}|${rule}`) ? { one: 1 } : null) as T | null;
    },
    async run() {
      const [zone, rule] = this._args;
      if (/^\s*INSERT/i.test(sql)) registered.add(`${zone}|${rule}`);
      else if (/^\s*DELETE/i.test(sql)) registered.delete(`${zone}|${rule}`);
      return { success: true };
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { prepare: (sql: string) => stmt(sql) } as any, registered };
}

const VERIFIED = {
  match: "/email/routing/addresses",
  res: () => cf({ success: true, result: [{ email: "me@dest.com", verified: "2024" }] }),
};

describe("createRule", () => {
  it("creates a literal-To rule delivering to the configured worker", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/rules", method: "POST", res: () => cf({ success: true, result: { id: "r1" } }) },
    ]);
    const r = await createRule(env, "z1", { to: "sales@a.com", action: "worker", workerName: "mailcove" }, 1000);
    expect(r).toEqual({ ok: true, id: "r1" });
    expect(calls[0].body).toMatchObject({
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "sales@a.com" }],
      actions: [{ type: "worker", value: ["mailcove"] }],
    });
  });

  it("refuses forward rules to unverified destinations (no POST issued)", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [{ email: "me@dest.com", verified: null }] }) },
    ]);
    const r = await createRule(env, "z1", { to: "x@a.com", action: "forward", forwardTo: "me@dest.com" }, 1000);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/rules"))).toBe(false);
  });

  it("forwards to a verified destination", async () => {
    const calls = recordingFetch([
      VERIFIED,
      { match: "/email/routing/rules", method: "POST", res: () => cf({ success: true, result: { tag: "r2" } }) },
    ]);
    const r = await createRule(env, "z1", { to: "x@a.com", action: "forward", forwardTo: "me@dest.com" }, 1000);
    expect(r).toEqual({ ok: true, id: "r2" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ actions: [{ type: "forward", value: ["me@dest.com"] }] });
  });

  it("requires a worker name for inbox delivery", async () => {
    const calls = recordingFetch([]);
    const r = await createRule(env, "z1", { to: "x@a.com", action: "worker" }, 1000);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("records the created rule id in the managed-rule registry", async () => {
    const { db, registered } = fakeDB();
    recordingFetch([
      { match: "/email/routing/rules", method: "POST", res: () => cf({ success: true, result: { id: "rX" } }) },
    ]);
    await createRule({ ...env, DB: db }, "z1", { to: "sales@a.com", action: "worker", workerName: "mailcove" }, 1234);
    expect(registered.has("z1|rX")).toBe(true);
  });
});

describe("setRuleEnabled", () => {
  const GUARD = { zoneName: "a.com", workerName: "mailcove" };
  const ruleFetch = (result: unknown) => ({
    match: "/email/routing/rules/r1",
    method: "GET",
    res: () => cf({ success: true, result }),
  });
  const RULE = {
    id: "r1",
    name: "rule: sales@a.com",
    enabled: true,
    priority: 7,
    matchers: [{ type: "literal", field: "to", value: "sales@a.com" }],
    actions: [{ type: "drop" }],
  };

  it("reads the rule then PUTs it back with only `enabled` flipped, preserving priority", async () => {
    const calls = recordingFetch([
      ruleFetch(RULE),
      { match: "/email/routing/rules/r1", method: "PUT", res: () => cf({ success: true, result: {} }) },
    ]);
    const r = await setRuleEnabled(env, "z1", "r1", false, GUARD);
    expect(r.ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      name: "rule: sales@a.com",
      enabled: false,
      priority: 7,
      matchers: [{ type: "literal", field: "to", value: "sales@a.com" }],
      actions: [{ type: "drop" }],
    });
  });

  it("fails when the rule can't be read (no blind PUT)", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/rules/rX", method: "GET", res: () => cf({ success: false }, 404) },
    ]);
    const r = await setRuleEnabled(env, "z1", "rX", true, GUARD);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses to replay a rule matching a DIFFERENT domain", async () => {
    const calls = recordingFetch([
      ruleFetch({ ...RULE, matchers: [{ type: "literal", field: "to", value: "x@evil.net" }] }),
    ]);
    const r = await setRuleEnabled(env, "z1", "r1", true, GUARD);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses to replay a rule targeting an unmanaged worker", async () => {
    const calls = recordingFetch([
      ruleFetch({ ...RULE, actions: [{ type: "worker", value: ["someone-elses-worker"] }] }),
    ]);
    const r = await setRuleEnabled(env, "z1", "r1", true, GUARD);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses to RE-ENABLE a forward rule whose target is no longer verified", async () => {
    const calls = recordingFetch([
      ruleFetch({ ...RULE, enabled: false, actions: [{ type: "forward", value: ["gone@x.com"] }] }),
      { match: "/email/routing/addresses", res: () => cf({ success: true, result: [{ email: "gone@x.com", verified: null }] }) },
    ]);
    const r = await setRuleEnabled(env, "z1", "r1", true, GUARD);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("allows DISABLING a forward rule regardless of verification (turning off is always safe)", async () => {
    const calls = recordingFetch([
      ruleFetch({ ...RULE, actions: [{ type: "forward", value: ["gone@x.com"] }] }),
      { match: "/email/routing/rules/r1", method: "PUT", res: () => cf({ success: true, result: {} }) },
    ]);
    const r = await setRuleEnabled(env, "z1", "r1", false, GUARD);
    expect(r.ok).toBe(true);
  });

  it("refuses a same-domain managed-shape rule that lacks our name marker (not app-created)", async () => {
    // Same literal-To-on-zone + forward shape a manually-authored CF rule has,
    // but named by hand — must NOT be treated as ours.
    const calls = recordingFetch([
      ruleFetch({ ...RULE, name: "billing forwarding", actions: [{ type: "forward", value: ["cfo@a.com"] }] }),
    ]);
    const r = await setRuleEnabled(env, "z1", "r1", false, GUARD);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("fails closed on malformed matcher/action shapes and unknown action types", async () => {
    recordingFetch([ruleFetch({ ...RULE, matchers: undefined })]);
    expect((await setRuleEnabled(env, "z1", "r1", true, GUARD)).ok).toBe(false);
    recordingFetch([ruleFetch({ ...RULE, actions: [{ type: "send_to_someone" }] })]);
    expect((await setRuleEnabled(env, "z1", "r1", true, GUARD)).ok).toBe(false);
  });
});

describe("deleteRule", () => {
  const GUARD = { zoneName: "a.com", workerName: "mailcove" };
  const MANAGED_RULE = {
    id: "r1",
    name: "rule: sales@a.com",
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: "sales@a.com" }],
    actions: [{ type: "drop" }],
  };

  it("reads then deletes a managed rule", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/rules/r1", method: "GET", res: () => cf({ success: true, result: MANAGED_RULE }) },
      { match: "/email/routing/rules/r1", method: "DELETE", res: () => cf({ success: true, result: {} }) },
    ]);
    expect((await deleteRule(env, "z1", "r1", GUARD)).ok).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("treats an already-gone rule (read 404) as converged without DELETE", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/rules/r1", method: "GET", res: () => cf({ success: false }, 404) },
    ]);
    expect((await deleteRule(env, "z1", "r1", GUARD)).ok).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes a registered rule even without the name marker (registry is authoritative), then forgets it", async () => {
    const { db, registered } = fakeDB(new Set(["z1|r9"]));
    const calls = recordingFetch([
      {
        match: "/email/routing/rules/r9",
        method: "GET",
        res: () =>
          cf({
            success: true,
            result: {
              id: "r9",
              name: "hand-named, no marker",
              matchers: [{ type: "literal", field: "to", value: "sales@a.com" }],
              actions: [{ type: "drop" }],
            },
          }),
      },
      { match: "/email/routing/rules/r9", method: "DELETE", res: () => cf({ success: true, result: {} }) },
    ]);
    expect((await deleteRule({ ...env, DB: db }, "z1", "r9", GUARD)).ok).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(registered.has("z1|r9")).toBe(false); // registry row dropped after delete
  });

  it("refuses to delete a same-domain managed-shape rule lacking our name marker — no DELETE issued", async () => {
    const calls = recordingFetch([
      {
        match: "/email/routing/rules/r1",
        method: "GET",
        res: () =>
          cf({
            success: true,
            result: { ...MANAGED_RULE, name: "billing forwarding", actions: [{ type: "forward", value: ["cfo@a.com"] }] },
          }),
      },
    ]);
    expect((await deleteRule(env, "z1", "r1", GUARD)).ok).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("refuses to delete an unmanaged rule (foreign domain) — no DELETE issued", async () => {
    const calls = recordingFetch([
      {
        match: "/email/routing/rules/r1",
        method: "GET",
        res: () =>
          cf({
            success: true,
            result: { ...MANAGED_RULE, matchers: [{ type: "literal", field: "to", value: "x@evil.net" }] },
          }),
      },
    ]);
    expect((await deleteRule(env, "z1", "r1", GUARD)).ok).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("refuses to delete a rule targeting an unmanaged worker — no DELETE issued", async () => {
    const calls = recordingFetch([
      {
        match: "/email/routing/rules/r1",
        method: "GET",
        res: () =>
          cf({
            success: true,
            result: { ...MANAGED_RULE, actions: [{ type: "worker", value: ["someone-elses-worker"] }] },
          }),
      },
    ]);
    expect((await deleteRule(env, "z1", "r1", GUARD)).ok).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("createDestination", () => {
  it("registers a new destination at the account level", async () => {
    const calls = recordingFetch([
      { match: "/email/routing/addresses", method: "POST", res: () => cf({ success: true, result: {} }) },
    ]);
    expect((await createDestination(env, "new@x.com")).ok).toBe(true);
    expect(calls[0].url).toContain("/accounts/acct123/email/routing/addresses");
    expect(calls[0].body).toEqual({ email: "new@x.com" });
  });

  it("converges when the destination already exists", async () => {
    recordingFetch([
      {
        match: "/email/routing/addresses",
        method: "POST",
        res: () => cf({ success: false, errors: [{ message: "destination address already exists" }] }),
      },
    ]);
    expect((await createDestination(env, "dup@x.com")).ok).toBe(true);
  });
});

describe("setCatchAll still validates via the shared action builder", () => {
  it("worker action requires a name; forward still requires verified", async () => {
    const calls = recordingFetch([]);
    expect((await setCatchAll(env, "z1", { action: "worker" })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
