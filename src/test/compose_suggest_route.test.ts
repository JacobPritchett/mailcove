import { describe, it, expect, vi } from "vitest";
import { handleFetch, type Env } from "../index";

const ctx = {} as ExecutionContext;

function makeEnv(opts: { response?: string; throws?: boolean } = {}) {
  const run = vi.fn(async () => {
    if (opts.throws) throw new Error("AI down");
    return { response: opts.response ?? "the rest of the sentence" };
  });
  return { DB: {} as unknown, AI: { run }, AUTH_TOKEN: "secret-token", ACCESS_TEAM_DOMAIN: "x", ACCESS_AUD: "a" } as unknown as Env;
}

function post(body: unknown, token = "secret-token") {
  return new Request("https://inbox.example.com/api/compose/suggest", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/compose/suggest", () => {
  it("returns an AI continuation", async () => {
    const res = await handleFetch(post({ subject: "Hi", text: "I wanted to ask about" }), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; suggestion: string };
    expect(body.ok).toBe(true);
    expect(body.suggestion).toContain("rest of the sentence");
  });

  it("degrades to an empty suggestion when the model errors (best-effort)", async () => {
    const res = await handleFetch(post({ subject: "Hi", text: "Something here" }), makeEnv({ throws: true }), ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { suggestion: string }).suggestion).toBe("");
  });

  it("requires auth", async () => {
    const res = await handleFetch(post({ text: "hello there" }, "nope"), makeEnv(), ctx);
    expect(res.status).toBe(401);
  });
});
