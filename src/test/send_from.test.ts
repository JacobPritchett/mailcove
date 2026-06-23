import { describe, it, expect, vi } from "vitest";
import { handleFetch, type Env } from "../index";

// Route-level tests for multi-domain /api/send (`from` identity) and
// GET /api/identities. The DB stub serves the `domains` registry SELECT (a
// parameterless .all() on the prepared statement) and records message INSERTs.
function makeEnv(domainRows: unknown[]) {
  const inserts: { sql: string; params: any[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: any[]) {
          if (/INSERT INTO messages\b/i.test(sql)) inserts.push({ sql, params });
          return {
            run: async () => ({}),
            // getDomainRow (sender-name profile lookup): emulate WHERE domain = ?.
            first: async () =>
              /FROM domains\b/i.test(sql)
                ? ((domainRows as { domain?: string }[]).find((r) => r.domain === params[0]) ?? null)
                : null,
            all: async () => ({ results: [] }),
          };
        },
        all: async () => (/FROM domains\b/i.test(sql) ? { results: domainRows } : { results: [] }),
        first: async () => null,
        run: async () => ({}),
      };
    },
  };
  const sendFn = vi.fn(async (_msg: unknown) => ({ messageId: "<real@cf>" }));
  const env = {
    DB: db as any,
    MAILSTORE: { put: vi.fn(async () => undefined) } as any,
    EMAIL: { send: sendFn } as any,
    INBOX_DOMAIN: "example.net",
    FROM_DOMAIN: "send.example.net",
    DEFAULT_FROM_LOCAL: "hello",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    AUTH_TOKEN: "secret-token",
  } as unknown as Env;
  return { env, inserts, sendFn };
}

const ROWS = [
  {
    domain: "example.com",
    zone_id: "z1",
    sending_domain: "example.com",
    receive_mode: "inbox",
    forward_copy_to: null,
    display_name: null,
  },
  {
    domain: "other.org",
    zone_id: "z2",
    sending_domain: "send.other.org",
    receive_mode: "inbox",
    forward_copy_to: null,
    display_name: "Other Org",
  },
];

function post(body: unknown) {
  return new Request("https://inbox.example.net/api/send", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
    body: JSON.stringify(body),
  });
}

const ctx = {} as ExecutionContext;

function insertedCols(insert: { sql: string; params: any[] }) {
  const cols = insert.sql
    .slice(insert.sql.indexOf("(") + 1, insert.sql.indexOf(")"))
    .split(",")
    .map((s) => s.trim());
  return (name: string) => insert.params[cols.indexOf(name)];
}

describe("/api/send with a `from` identity", () => {
  it("apex-onboarded identity: From IS the identity address, no Reply-To", async () => {
    const { env, sendFn, inserts } = makeEnv(ROWS);
    const res = await handleFetch(post({ to: "x@y.com", text: "hi", from: "team@example.com" }), env, ctx);
    expect(res.status).toBe(200);
    const msg = sendFn.mock.calls[0][0] as { from: { email: string; name: string }; replyTo?: string };
    expect(msg.from.email).toBe("team@example.com");
    expect(msg.replyTo).toBeUndefined();
    expect(msg.from.name).toBe("Example");
    const col = insertedCols(inserts[0]);
    expect(col("msg_from")).toBe("team@example.com");
    expect(col("domain")).toBe("example.com");
  });

  it("send.* identity: transport From on the subdomain, identity on Reply-To", async () => {
    const { env, sendFn, inserts } = makeEnv(ROWS);
    const res = await handleFetch(post({ to: "x@y.com", text: "hi", from: "hi@other.org" }), env, ctx);
    expect(res.status).toBe(200);
    const msg = sendFn.mock.calls[0][0] as { from: { email: string; name: string }; replyTo?: string };
    expect(msg.from.email).toBe("hi@send.other.org");
    expect(msg.replyTo).toBe("hi@other.org");
    expect(msg.from.name).toBe("Other Org");
    const col = insertedCols(inserts[0]);
    expect(col("msg_from")).toBe("hi@other.org");
    expect(col("domain")).toBe("other.org");
  });

  it("rejects an unknown from-domain with 400 and does NOT send", async () => {
    const { env, sendFn } = makeEnv(ROWS);
    const res = await handleFetch(post({ to: "x@y.com", text: "hi", from: "a@evil.net" }), env, ctx);
    expect(res.status).toBe(400);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("from on the env default identity works even with an empty registry (legacy equivalence)", async () => {
    const { env, sendFn } = makeEnv([]);
    const res = await handleFetch(
      post({ to: "x@y.com", text: "hi", from: "team@example.net" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const msg = sendFn.mock.calls[0][0] as { from: { email: string }; replyTo?: string };
    expect(msg.from.email).toBe("team@send.example.net");
    expect(msg.replyTo).toBe("team@example.net");
  });

  it("explicit fromName still overrides the identity display name", async () => {
    const { env, sendFn } = makeEnv(ROWS);
    await handleFetch(post({ to: "x@y.com", text: "hi", from: "team@example.com", fromName: "Custom" }), env, ctx);
    const msg = sendFn.mock.calls[0][0] as { from: { name: string } };
    expect(msg.from.name).toBe("Custom");
  });

  it("fromName is sanitized — CR/LF can never reach the From header", async () => {
    const { env, sendFn } = makeEnv(ROWS);
    await handleFetch(
      post({ to: "x@y.com", text: "hi", from: "team@example.com", fromName: " Alex\r\nBcc: evil@x.com " }),
      env,
      ctx,
    );
    const msg = sendFn.mock.calls[0][0] as { from: { name: string } };
    expect(msg.from.name).toBe("Alex Bcc: evil@x.com");
  });

  it("a whitespace-only fromName falls back to the identity's profile name", async () => {
    const { env, sendFn } = makeEnv(ROWS);
    await handleFetch(post({ to: "x@y.com", text: "hi", from: "hi@other.org", fromName: "  " }), env, ctx);
    const msg = sendFn.mock.calls[0][0] as { from: { name: string } };
    expect(msg.from.name).toBe("Other Org");
  });

  it("legacy path (no `from`) honors a saved sender-name profile", async () => {
    const PROFILE = {
      domain: "example.net",
      zone_id: null,
      sending_domain: null,
      receive_mode: null,
      forward_copy_to: null,
      display_name: "Shiny Page",
    };
    const { env, sendFn } = makeEnv([PROFILE]);
    const res = await handleFetch(post({ to: "x@y.com", text: "hi" }), env, ctx);
    expect(res.status).toBe(200);
    const msg = sendFn.mock.calls[0][0] as { from: { email: string; name: string } };
    expect(msg.from.email).toBe("hello@send.example.net");
    expect(msg.from.name).toBe("Shiny Page");
  });

  it("legacy path (no `from`) is unchanged even with registry rows present", async () => {
    const { env, sendFn, inserts } = makeEnv(ROWS);
    const res = await handleFetch(post({ to: "x@y.com", text: "hi", fromLocal: "team" }), env, ctx);
    expect(res.status).toBe(200);
    const msg = sendFn.mock.calls[0][0] as { from: { email: string; name: string }; replyTo?: string };
    expect(msg.from.email).toBe("team@send.example.net");
    expect(msg.replyTo).toBe("team@example.net");
    expect(msg.from.name).toBe("Example");
    const col = insertedCols(inserts[0]);
    expect(col("msg_from")).toBe("team@example.net");
    expect(col("domain")).toBe("example.net");
  });
});

describe("GET /api/identities", () => {
  it("returns registry identities plus the default local/domain", async () => {
    const { env } = makeEnv(ROWS);
    const res = await handleFetch(
      new Request("https://inbox.example.net/api/identities", {
        headers: { Authorization: "Bearer secret-token" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Registry rows plus the always-sendable env default identity, sorted.
    expect(body.identities.map((i: any) => i.domain)).toEqual([
      "example.com",
      "example.net",
      "other.org",
    ]);
    expect(body.defaultLocal).toBe("hello");
    expect(body.defaultDomain).toBe("example.net");
  });

  it("falls back to the env identity when the registry is empty", async () => {
    const { env } = makeEnv([]);
    const res = await handleFetch(
      new Request("https://inbox.example.net/api/identities", {
        headers: { Authorization: "Bearer secret-token" },
      }),
      env,
      ctx,
    );
    const body = (await res.json()) as any;
    expect(body.identities).toEqual([
      { domain: "example.net", sendingDomain: "send.example.net", displayName: "Example" },
    ]);
  });
});
