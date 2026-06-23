import { describe, it, expect, vi } from "vitest";
import { handleFetch, type Env } from "../index";

const ctx = {} as ExecutionContext;

/** Mock D1 recording prepared SQL + binds; run() is a no-op. */
function makeEnv(opts: { vapidPublic?: string | null } = {}) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return { run: async () => ({}), all: async () => ({ results: [] }), first: async () => null };
        },
      };
    },
  };
  const env = {
    DB: db as unknown,
    AUTH_TOKEN: "secret-token",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    VAPID_PUBLIC: "vapidPublic" in opts ? opts.vapidPublic ?? undefined : "BKtest",
    VAPID_PRIVATE: "vapidPublic" in opts && opts.vapidPublic == null ? undefined : "privTest",
  } as unknown as Env;
  return { env, calls };
}

// Valid-shaped key material (65-byte point, 16-byte auth) — reuse the RFC vector.
const VALID_P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const FCM = "https://fcm.googleapis.com/fcm/send/abc123";

function req(path: string, method: string, body?: unknown, token = "secret-token") {
  return new Request(`https://inbox.example.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("GET /api/push/key", () => {
  it("returns the VAPID public key when configured", async () => {
    const { env } = makeEnv();
    const res = await handleFetch(req("/api/push/key", "GET"), env, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { key: string }).key).toBe("BKtest");
  });
  it("503s when push isn't configured (no public key)", async () => {
    const { env } = makeEnv({ vapidPublic: null });
    const res = await handleFetch(req("/api/push/key", "GET"), env, ctx);
    expect(res.status).toBe(503);
  });
  it("503s when the private key is missing (can't actually send)", async () => {
    const { env } = makeEnv();
    (env as { VAPID_PRIVATE?: string }).VAPID_PRIVATE = undefined;
    const res = await handleFetch(req("/api/push/key", "GET"), env, ctx);
    expect(res.status).toBe(503);
  });
  it("requires auth", async () => {
    const { env } = makeEnv();
    const res = await handleFetch(req("/api/push/key", "GET", undefined, "nope"), env, ctx);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/push/subscribe", () => {
  const sub = { endpoint: FCM, keys: { p256dh: VALID_P256DH, auth: VALID_AUTH } };

  it("upserts a valid subscription from a known push host", async () => {
    const { env, calls } = makeEnv();
    const res = await handleFetch(req("/api/push/subscribe", "POST", sub), env, ctx);
    expect(res.status).toBe(200);
    const insert = calls.find((c) => /INSERT INTO push_subscriptions/i.test(c.sql));
    expect(insert).toBeTruthy();
    expect(insert!.binds.slice(0, 3)).toEqual([FCM, VALID_P256DH, VALID_AUTH]);
  });

  it("rejects a missing key", async () => {
    const { env } = makeEnv();
    const res = await handleFetch(
      req("/api/push/subscribe", "POST", { endpoint: FCM, keys: { p256dh: VALID_P256DH } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an endpoint that isn't a known push service (SSRF guard)", async () => {
    const { env } = makeEnv();
    const res = await handleFetch(
      req("/api/push/subscribe", "POST", { endpoint: "https://evil.example.com/x", keys: { p256dh: VALID_P256DH, auth: VALID_AUTH } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed key material (wrong byte length)", async () => {
    const { env } = makeEnv();
    const res = await handleFetch(
      req("/api/push/subscribe", "POST", { endpoint: FCM, keys: { p256dh: "PPP", auth: "AAA" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/push/unsubscribe", () => {
  it("deletes the subscription", async () => {
    const { env, calls } = makeEnv();
    const res = await handleFetch(
      req("/api/push/unsubscribe", "POST", { endpoint: "https://push.example.com/abc" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const del = calls.find((c) => /DELETE FROM push_subscriptions/i.test(c.sql));
    expect(del!.binds).toEqual(["https://push.example.com/abc"]);
  });
  it("400s without an endpoint", async () => {
    const { env } = makeEnv();
    const res = await handleFetch(req("/api/push/unsubscribe", "POST", {}), env, ctx);
    expect(res.status).toBe(400);
  });
});
