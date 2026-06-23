import { describe, it, expect } from "vitest";
import { handleFetch, type Env } from "../index";

const ctx = {} as ExecutionContext;

function makeEnv() {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return { run: async () => ({}), all: async () => ({ results: [] }), first: async () => null };
        },
        // Statements run without bind() (e.g. SELECT COUNT(*)).
        all: async () => ({ results: [] }),
        first: async () => ({ n: 0 }),
        run: async () => ({}),
      };
    },
  };
  return { env: { DB: db, AUTH_TOKEN: "secret-token", ACCESS_TEAM_DOMAIN: "x", ACCESS_AUD: "a" } as unknown as Env, calls };
}

function req(path: string, method: string, body?: unknown, token = "secret-token") {
  return new Request(`https://inbox.example.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("filters CRUD", () => {
  it("lists filters", async () => {
    const { env } = makeEnv();
    const res = await handleFetch(req("/api/filters", "GET"), env, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()) as { filters: unknown[] }).toHaveProperty("filters");
  });

  it("creates a valid filter", async () => {
    const { env, calls } = makeEnv();
    const res = await handleFetch(
      req("/api/filters", "POST", { field: "from", op: "contains", value: "spam.com", action: "trash" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const insert = calls.find((c) => /INSERT INTO filters/i.test(c.sql));
    expect(insert!.binds.slice(1, 5)).toEqual(["from", "contains", "spam.com", "trash"]);
  });

  it("rejects an invalid field/action/empty value", async () => {
    const { env } = makeEnv();
    for (const bad of [
      { field: "cc", op: "contains", value: "x", action: "trash" },
      { field: "from", op: "contains", value: "x", action: "explode" },
      { field: "from", op: "nope", value: "x", action: "trash" },
      { field: "from", op: "contains", value: "  ", action: "trash" },
    ]) {
      const res = await handleFetch(req("/api/filters", "POST", bad), env, ctx);
      expect(res.status).toBe(400);
    }
  });

  it("toggles and deletes a filter", async () => {
    const { env, calls } = makeEnv();
    expect((await handleFetch(req("/api/filters/abc", "PATCH", { enabled: false }), env, ctx)).status).toBe(200);
    expect(calls.some((c) => /UPDATE filters SET enabled=/i.test(c.sql))).toBe(true);
    expect((await handleFetch(req("/api/filters/abc", "DELETE"), env, ctx)).status).toBe(200);
    expect(calls.some((c) => /DELETE FROM filters/i.test(c.sql))).toBe(true);
  });

  it("requires auth", async () => {
    const { env } = makeEnv();
    expect((await handleFetch(req("/api/filters", "GET", undefined, "nope"), env, ctx)).status).toBe(401);
  });
});
