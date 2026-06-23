import { describe, it, expect } from "vitest";
import { handleFetch, type Env } from "../index";
import { validateDraft, DRAFT_LIMITS } from "../drafts";

// Route + unit tests for the drafts store (autosaved compose state).

const ctx = {} as ExecutionContext;

/** DB stub: records run() statements; serves drafts SELECTs from `rows`. */
function makeEnv(rows: Record<string, unknown>[] = [], opts: { throwAll?: boolean } = {}) {
  const statements: { sql: string; params: any[] }[] = [];
  const db = {
    prepare(sql: string) {
      const rec = { sql, params: [] as any[] };
      const stmt = {
        bind(...params: any[]) {
          rec.params = params;
          return stmt;
        },
        run: async () => {
          statements.push(rec);
          return {};
        },
        first: async () => {
          if (/FROM drafts\b/i.test(sql)) {
            if (/COUNT\(\*\)/i.test(sql)) return { n: rows.length };
            return rows.find((r) => r.id === rec.params[0]) ?? null;
          }
          return null;
        },
        all: async () => {
          if (opts.throwAll) throw new Error("no such table: drafts");
          return { results: /FROM drafts\b/i.test(sql) ? rows : [] };
        },
      };
      return stmt;
    },
  };
  const env = {
    DB: db as any,
    MAILSTORE: {} as any,
    AUTH_TOKEN: "secret-token",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    INBOX_DOMAIN: "example.com",
    FROM_DOMAIN: "send.example.com",
    DEFAULT_FROM_LOCAL: "hello",
  } as unknown as Env;
  return { env, statements };
}

function req(path: string, method: string, body?: unknown) {
  return new Request(`https://inbox.example.com${path}`, {
    method,
    headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ROW = {
  id: "d1234567-aaaa-bbbb-cccc-000000000001",
  thread_id: "t1",
  in_reply_to: "<mid@x>",
  msg_to: "a@b.com",
  subject: "Hi",
  body_text: "line one\n\nline   two",
  body_json: `{"type":"doc"}`,
  from_local: "hello",
  from_domain: "example.com",
  from_name: "Shiny",
  updated: 123,
};

describe("PUT /api/drafts/:id", () => {
  it("upserts the draft with all provided fields", async () => {
    const { env, statements } = makeEnv();
    const res = await handleFetch(
      req(`/api/drafts/${ROW.id}`, "PUT", {
        to: "a@b.com",
        subject: "Hi",
        bodyText: "hello",
        bodyJson: `{"type":"doc"}`,
        threadId: "t1",
        inReplyTo: "<mid@x>",
        fromLocal: "hello",
        fromDomain: "example.com",
        fromName: "Shiny",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const insert = statements.find((s) => /INSERT INTO drafts/i.test(s.sql))!;
    expect(insert).toBeTruthy();
    expect(insert.params[0]).toBe(ROW.id);
    expect(insert.params[3]).toBe("a@b.com"); // msg_to
    expect(insert.params[6]).toBe(`{"type":"doc"}`); // body_json
  });

  it("rejects oversized bodies and bad ids", async () => {
    const { env, statements } = makeEnv();
    const big = "x".repeat(DRAFT_LIMITS.bodyText + 1);
    expect(
      (await handleFetch(req(`/api/drafts/${ROW.id}`, "PUT", { bodyText: big }), env, ctx)).status,
    ).toBe(400);
    expect(
      (await handleFetch(req(`/api/drafts/bad`, "PUT", { bodyText: "x" }), env, ctx)).status,
    ).toBe(404); // id shorter than the route's 8-char minimum never matches
    expect(statements.some((s) => /INSERT INTO drafts/i.test(s.sql))).toBe(false);
  });
});

describe("GET /api/drafts (+/:id) and DELETE", () => {
  it("lists newest-first summaries with collapsed snippets", async () => {
    const { env } = makeEnv([ROW]);
    const res = await handleFetch(req("/api/drafts", "GET"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.drafts).toEqual([
      {
        id: ROW.id,
        threadId: "t1",
        to: "a@b.com",
        subject: "Hi",
        snippet: "line one line two",
        updated: 123,
      },
    ]);
  });

  it("returns the full draft for resume; 404s a missing one", async () => {
    const { env } = makeEnv([ROW]);
    const res = await handleFetch(req(`/api/drafts/${ROW.id}`, "GET"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: ROW.id,
      bodyText: "line one\n\nline   two",
      bodyJson: `{"type":"doc"}`,
      fromDomain: "example.com",
      inReplyTo: "<mid@x>",
    });
    const miss = await handleFetch(
      req(`/api/drafts/ffffffff-0000-0000-0000-000000000000`, "GET"),
      env,
      ctx,
    );
    expect(miss.status).toBe(404);
  });

  it("DELETE removes the draft (and converges when the table is missing)", async () => {
    const { env, statements } = makeEnv([ROW]);
    const res = await handleFetch(req(`/api/drafts/${ROW.id}`, "DELETE"), env, ctx);
    expect(res.status).toBe(200);
    expect(statements.some((s) => /DELETE FROM drafts/i.test(s.sql))).toBe(true);
  });

  it("an empty/missing table lists as [] instead of erroring (pre-migration)", async () => {
    const { env } = makeEnv([], { throwAll: true });
    const res = await handleFetch(req("/api/drafts", "GET"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drafts: [] });
  });
});

describe("validateDraft", () => {
  it("accepts a minimal payload and drops non-string fields", () => {
    const v = validateDraft({ id: ROW.id, bodyText: "x", subject: 7 });
    expect("draft" in v && v.draft.subject).toBeUndefined();
    expect("draft" in v && v.draft.bodyText).toBe("x");
  });

  it("rejects bad ids", () => {
    expect(validateDraft({ id: "short" })).toEqual({ error: "invalid draft id" });
    expect(validateDraft({ id: "has spaces in it" })).toEqual({ error: "invalid draft id" });
  });

  it("caps metadata fields, not just bodies", () => {
    expect(validateDraft({ id: ROW.id, threadId: "t".repeat(257) })).toEqual({
      error: "draft 'threadId' too large",
    });
    expect(validateDraft({ id: ROW.id, fromName: "n".repeat(101) })).toEqual({
      error: "draft 'fromName' too large",
    });
  });

  it("rejects bodyJson that is not a TipTap document", () => {
    expect(validateDraft({ id: ROW.id, bodyJson: "not json" })).toEqual({
      error: "draft bodyJson is not valid JSON",
    });
    expect(validateDraft({ id: ROW.id, bodyJson: `{"x":1}` })).toEqual({
      error: "draft bodyJson is not an editor document",
    });
    const ok = validateDraft({ id: ROW.id, bodyJson: `{"type":"doc","content":[]}` });
    expect("draft" in ok).toBe(true);
  });
});
