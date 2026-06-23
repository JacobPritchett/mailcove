import { describe, it, expect } from "vitest";
import { handleFetch, type Env, normalizeAddress } from "../index";

describe("normalizeAddress", () => {
  it("lowercases and unwraps angle brackets", () => {
    expect(normalizeAddress("Foo <Bar@Example.COM>")).toBe("bar@example.com");
    expect(normalizeAddress("a@b.com")).toBe("a@b.com");
  });
});

function makeEnv(captured: { sql: string; params: unknown[] }[]) {
  const db = {
    prepare(sql: string) {
      return { bind: (...params: unknown[]) => { captured.push({ sql, params }); return { run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }; } };
    },
  };
  return { DB: db as unknown, AUTH_TOKEN: "tok", ACCESS_TEAM_DOMAIN: "x", ACCESS_AUD: "a" } as unknown as Env;
}
const ctx = {} as ExecutionContext;

describe("/api/senders/images", () => {
  it("POST inserts a normalized address", async () => {
    const cap: { sql: string; params: unknown[] }[] = [];
    const env = makeEnv(cap);
    const req = new Request("https://inbox.example.com/api/senders/images", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json", Origin: "https://inbox.example.com" },
      body: JSON.stringify({ address: "Name <X@Y.COM>" }),
    });
    const res = await handleFetch(req, env, ctx);
    expect(res.status).toBe(200);
    const ins = cap.find((q) => /INSERT INTO image_senders/i.test(q.sql));
    expect(ins?.params[0]).toBe("x@y.com");
  });
});
