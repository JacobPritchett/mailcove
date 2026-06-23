import { describe, it, expect } from "vitest";
import { handleFetch, type Env } from "../index";

// Regression: /api/threads/:id must DECODE the percent-encoded thread id before
// the DB lookup. thread_ids are RFC Message-IDs (<...@host>) which the client
// encodeURIComponent's; without a decode the query never matches and the reader
// shows "Couldn't load this conversation" for every email.
function makeEnv() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          call.params = params;
          queries.push(call);
          return {
            all: async () => ({
              results: /WHERE thread_id=/.test(sql)
                ? [{ id: "m1", thread_id: params[0], subject: "Hi" }]
                : [],
            }),
            first: async () => null,
            run: async () => ({}),
          };
        },
      };
    },
  };
  const r2 = {
    get: async () => ({ json: async () => ({ text: "body", html: "", attachments: [] }) }),
  };
  const env = {
    DB: db as unknown,
    MAILSTORE: r2 as unknown,
    AUTH_TOKEN: "secret-token",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
  } as unknown as Env;
  return { env, queries };
}

const ctx = {} as ExecutionContext;

describe("/api/threads/:id", () => {
  it("decodes a percent-encoded Message-ID thread id before the DB lookup", async () => {
    const { env, queries } = makeEnv();
    const tid = "<abc@send.example.com>";
    const req = new Request(`https://inbox.example.com/api/threads/${encodeURIComponent(tid)}`, {
      headers: { Authorization: "Bearer secret-token" },
    });

    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { thread_id: string; messages: unknown[] };
    expect(body.thread_id).toBe(tid); // decoded, not "%3Cabc%40..."
    expect(body.messages.length).toBe(1);

    const threadQuery = queries.find((q) => /WHERE thread_id=/.test(q.sql));
    expect(threadQuery?.params[0]).toBe(tid);
  });

  it("returns 400 on a malformed percent-encoding", async () => {
    const { env } = makeEnv();
    const req = new Request("https://inbox.example.com/api/threads/%E0%A4%A", {
      headers: { Authorization: "Bearer secret-token" },
    });
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(400);
  });
});
