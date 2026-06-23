import { describe, it, expect } from "vitest";
import { handleFetch, type Env } from "../index";

function makeEnv() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] };
      const bound = {
        run: async () => ({}),
        all: async () => ({ results: [] }),
        first: async () => ({ n: 0 }),
      };
      return {
        // Some paths call .first() directly on the prepared stmt (no bind args)
        first: async () => ({ n: 0 }),
        bind(...params: unknown[]) {
          call.params = params;
          queries.push(call);
          return bound;
        },
      };
    },
  };
  const mailstore = { delete: async () => {}, list: async () => ({ objects: [], truncated: false }) };
  const env = {
    DB: db as unknown,
    MAILSTORE: mailstore as unknown,
    AUTH_TOKEN: "secret-token",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
  } as unknown as Env;
  return { env, queries };
}

const ctx = {} as ExecutionContext;
const bearer = { Authorization: "Bearer secret-token" };

describe("POST /api/threads/:id/mutate", () => {
  it("returns 200 and issues UPDATE for valid action", async () => {
    const { env, queries } = makeEnv();
    const req = new Request("https://inbox.example.com/api/threads/t1/mutate", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ action: "archive" }),
    });
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    const updateQuery = queries.find((q) => /UPDATE messages SET state='archived'/.test(q.sql));
    expect(updateQuery).toBeTruthy();
  });

  it("returns 400 for an invalid action", async () => {
    const { env } = makeEnv();
    const req = new Request("https://inbox.example.com/api/threads/t1/mutate", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ action: "bogus" }),
    });
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/messages/mutate (bulk)", () => {
  it("returns 200 with {ok:true,count:2} for two thread IDs", async () => {
    const { env } = makeEnv();
    const req = new Request("https://inbox.example.com/api/messages/mutate", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ threadIds: ["t1", "t2"], action: "trash" }),
    });
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; count: number };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
  });

  it("returns 400 when threadIds exceeds the 200 cap", async () => {
    const { env } = makeEnv();
    const threadIds = Array.from({ length: 201 }, (_, i) => `t${i}`);
    const req = new Request("https://inbox.example.com/api/messages/mutate", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ threadIds, action: "trash" }),
    });
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/max 200/);
  });
});

describe("GET /api/counts", () => {
  it("returns 200 with a numeric inbox field", async () => {
    const { env } = makeEnv();
    const req = new Request("https://inbox.example.com/api/counts", {
      headers: bearer,
    });
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as { inbox: number };
    expect(typeof body.inbox).toBe("number");
  });
});

describe("GET /api/messages?view=trash", () => {
  it("returns 200 when using view param", async () => {
    const { env } = makeEnv();
    const req = new Request("https://inbox.example.com/api/messages?view=trash", {
      headers: bearer,
    });
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/messages?domain=", () => {
  it("400s a present-but-invalid domain instead of silently unfiltering", async () => {
    const { env } = makeEnv();
    const req = new Request(
      "https://inbox.example.com/api/messages?view=inbox&domain=x%27%20OR%201",
      { headers: bearer },
    );
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it("accepts a valid domain", async () => {
    const { env } = makeEnv();
    const req = new Request(
      "https://inbox.example.com/api/messages?view=inbox&domain=example.org",
      { headers: bearer },
    );
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(200);
  });
});
