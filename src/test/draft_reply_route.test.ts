import { describe, it, expect, vi } from "vitest";
import { handleFetch, type Env } from "../index";

// Env for POST /api/threads/:id/draft-reply. getThread reads message rows from
// D1 (rows when the query filters by thread_id) + bodies from R2; the AI binding
// is a vi.fn we control. Auth uses the AUTH_TOKEN bearer path.
function makeEnv(opts: { rows?: unknown[]; aiResponse?: string; aiThrows?: boolean } = {}) {
  const rows = opts.rows ?? [{ id: "m1", thread_id: "t1", direction: "in", msg_from: "Alice", subject: "Lunch", date: 1 }];
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            all: async () => ({ results: /WHERE thread_id=/.test(sql) ? rows : [] }),
            first: async () => null,
            run: async () => ({}),
          };
        },
      };
    },
  };
  const r2 = { get: async () => ({ json: async () => ({ text: "Are we on for lunch?", html: "", attachments: [] }) }) };
  const run = vi.fn(async () => {
    if (opts.aiThrows) throw new Error("AI unavailable");
    return { response: opts.aiResponse ?? "Sure — noon works for me." };
  });
  const env = {
    DB: db as unknown,
    MAILSTORE: r2 as unknown,
    AI: { run } as unknown,
    AUTH_TOKEN: "secret-token",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
  } as unknown as Env;
  return { env, run };
}

const ctx = {} as ExecutionContext;
function post(tid: string, token = "secret-token") {
  return new Request(`https://inbox.example.com/api/threads/${encodeURIComponent(tid)}/draft-reply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("POST /api/threads/:id/draft-reply", () => {
  it("returns an AI-drafted reply body", async () => {
    const { env, run } = makeEnv();
    const res = await handleFetch(post("t1"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; draft: string };
    expect(body.ok).toBe(true);
    expect(body.draft).toMatch(/noon/i);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("404s an empty/unknown thread without calling the model", async () => {
    const { env, run } = makeEnv({ rows: [] });
    const res = await handleFetch(post("nope"), env, ctx);
    expect(res.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("maps an AI failure to 502 (graceful)", async () => {
    const { env } = makeEnv({ aiThrows: true });
    const res = await handleFetch(post("t1"), env, ctx);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("draft failed");
  });

  it("502s when the model returns an empty draft (draftReply throws)", async () => {
    const { env } = makeEnv({ aiResponse: "   " });
    const res = await handleFetch(post("t1"), env, ctx);
    expect(res.status).toBe(502);
  });

  it("requires auth", async () => {
    const { env } = makeEnv();
    const res = await handleFetch(post("t1", "wrong"), env, ctx);
    expect(res.status).toBe(401);
  });
});
