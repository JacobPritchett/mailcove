import { describe, it, expect, vi } from "vitest";
import worker, { type Env } from "../index";

// Domain attribution for inbound mail: the ENVELOPE recipient (RCPT TO) wins,
// the To header is the fallback, then the default inbox domain.

const RAW = [
  "From: Alice <alice@example.com>",
  "To: Bob <bob@header-domain.org>",
  "Subject: hi",
  "Message-ID: <m1@example.com>",
  "Date: Mon, 08 Jun 2026 12:00:00 +0000",
  "",
  "hello",
].join("\r\n");

function makeEnv() {
  const inserts: { sql: string; params: any[] }[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...params: any[]) {
          if (/INSERT INTO messages\b/i.test(sql)) inserts.push({ sql, params });
          return stmt;
        },
        run: async () => ({}),
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
  };
  const env = {
    DB: db as any,
    MAILSTORE: { put: vi.fn(async () => undefined) } as any,
    INBOX_DOMAIN: "example.com",
    FROM_DOMAIN: "send.example.com",
    DEFAULT_FROM_LOCAL: "hello",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
  } as unknown as Env;
  return { env, inserts };
}

function makeMessage(envelopeTo: string, raw = RAW) {
  return {
    from: "alice@example.com",
    to: envelopeTo,
    raw: new Response(raw).body,
    rawSize: raw.length,
    headers: new Headers(),
    setReject: () => {},
    forward: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  } as unknown as ForwardableEmailMessage;
}

function makeCtx() {
  const tail: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tail.push(p.catch(() => {})) } as unknown as ExecutionContext;
  return { ctx, tail };
}

function domainOfInsert(insert: { sql: string; params: any[] }): string {
  const cols = insert.sql
    .slice(insert.sql.indexOf("(") + 1, insert.sql.indexOf(")"))
    .split(",")
    .map((s) => s.trim());
  return insert.params[cols.indexOf("domain")];
}

describe("inbound domain attribution", () => {
  it("uses the envelope recipient's domain, not the To header", async () => {
    const { env, inserts } = makeEnv();
    const { ctx, tail } = makeCtx();
    await worker.email(makeMessage("catch@example.org"), env, ctx);
    await Promise.all(tail);
    expect(inserts).toHaveLength(1);
    expect(domainOfInsert(inserts[0])).toBe("example.org");
  });

  it("normalizes the envelope domain to lowercase", async () => {
    const { env, inserts } = makeEnv();
    const { ctx, tail } = makeCtx();
    await worker.email(makeMessage("X@Example.ORG"), env, ctx);
    await Promise.all(tail);
    expect(domainOfInsert(inserts[0])).toBe("example.org");
  });

  it("unwraps an angle-bracket envelope path", async () => {
    const { env, inserts } = makeEnv();
    const { ctx, tail } = makeCtx();
    await worker.email(makeMessage("<user@example.org>"), env, ctx);
    await Promise.all(tail);
    expect(domainOfInsert(inserts[0])).toBe("example.org");
  });

  it("rejects a junk envelope domain and falls back to the header", async () => {
    const { env, inserts } = makeEnv();
    const { ctx, tail } = makeCtx();
    await worker.email(makeMessage("user@bad domain!"), env, ctx);
    await Promise.all(tail);
    expect(domainOfInsert(inserts[0])).toBe("header-domain.org");
  });

  it("falls back to the To header's domain when the envelope has none", async () => {
    const { env, inserts } = makeEnv();
    const { ctx, tail } = makeCtx();
    await worker.email(makeMessage(""), env, ctx);
    await Promise.all(tail);
    expect(domainOfInsert(inserts[0])).toBe("header-domain.org");
  });

  it("falls back to INBOX_DOMAIN when neither carries an address", async () => {
    const raw = RAW.replace("To: Bob <bob@header-domain.org>\r\n", "");
    const { env, inserts } = makeEnv();
    const { ctx, tail } = makeCtx();
    await worker.email(makeMessage("", raw), env, ctx);
    await Promise.all(tail);
    expect(domainOfInsert(inserts[0])).toBe("example.com");
  });
});
