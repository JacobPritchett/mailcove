// Ingest must record the message even when attachment storage misbehaves.
// The raw .eml is written first and the D1 row last, so anything that throws in
// between leaves mail sitting in R2 that never appears in the inbox.
import { describe, it, expect, vi } from "vitest";
import worker, { type Env } from "../index";
import { MAX_INBOUND_ATTACHMENTS } from "../attachments";

function rawWithAttachments(count: number): string {
  const b = "BOUND";
  const parts = Array.from({ length: count }, (_, i) =>
    [
      `--${b}`,
      `Content-Type: application/octet-stream; name="f${i}.bin"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="f${i}.bin"`,
      "",
      "QUJD",
      "",
    ].join("\r\n"),
  ).join("");
  return [
    "From: Alice <alice@example.com>",
    "To: Bob <bob@example.com>",
    "Subject: with files",
    "Message-ID: <m-att@example.com>",
    "Date: Mon, 08 Jun 2026 12:00:00 +0000",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain",
    "",
    "body text",
    "",
    parts,
    `--${b}--`,
    "",
  ].join("\r\n");
}

function makeEnv(put: (key: string) => Promise<unknown>) {
  const inserts: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...params: unknown[]) {
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
    DB: db as unknown,
    MAILSTORE: { put: vi.fn(put) } as unknown,
    INBOX_DOMAIN: "example.com",
    FROM_DOMAIN: "send.example.com",
    DEFAULT_FROM_LOCAL: "hello",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
  } as unknown as Env;
  return { env, inserts };
}

function makeMessage(raw: string) {
  return {
    from: "alice@example.com",
    to: "bob@example.com",
    raw: new Response(raw).body,
    rawSize: raw.length,
    headers: new Headers(),
    setReject: () => {},
    forward: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  } as unknown as ForwardableEmailMessage;
}

const makeCtx = () =>
  ({ waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) }) as unknown as ExecutionContext;

describe("inbound delivery resilience", () => {
  it("still records the message when every attachment write fails", async () => {
    const { env, inserts } = makeEnv(async (key: string) => {
      if (key.startsWith("att/")) throw new Error("R2 unavailable");
      return undefined;
    });

    await worker.email!(makeMessage(rawWithAttachments(2)), env, makeCtx());

    // The whole point: a storage hiccup must not make delivered mail invisible.
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toContain("with files");
  });

  it("bounds how many attachment writes one message can trigger", async () => {
    const seen: string[] = [];
    const { env, inserts } = makeEnv(async (key: string) => {
      seen.push(key);
      return undefined;
    });

    await worker.email!(makeMessage(rawWithAttachments(MAX_INBOUND_ATTACHMENTS + 10)), env, makeCtx());

    const attWrites = seen.filter((k) => k.startsWith("att/"));
    expect(attWrites.length).toBeLessThanOrEqual(MAX_INBOUND_ATTACHMENTS);
    expect(inserts).toHaveLength(1);
  });

  it("still records the message when the parsed-body write fails", async () => {
    const { env, inserts } = makeEnv(async (key: string) => {
      if (key.startsWith("parsed/")) throw new Error("R2 unavailable");
      return undefined;
    });

    await worker.email!(makeMessage(rawWithAttachments(1)), env, makeCtx());

    // Losing the body is recoverable; losing the message is not.
    expect(inserts).toHaveLength(1);
  });

  it("still records the message when the thread lookup fails", async () => {
    const inserts: { sql: string; params: unknown[] }[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind(...params: unknown[]) {
            if (/INSERT INTO messages\b/i.test(sql)) inserts.push({ sql, params });
            return stmt;
          },
          run: async () => ({}),
          first: async () => {
            if (/FROM messages/i.test(sql) && /message_id/i.test(sql)) throw new Error("D1 read failed");
            return null;
          },
          all: async () => {
            if (/FROM messages/i.test(sql) && /message_id/i.test(sql)) throw new Error("D1 read failed");
            return { results: [] };
          },
        };
        return stmt;
      },
    };
    const env = {
      DB: db as unknown,
      MAILSTORE: { put: vi.fn(async () => undefined) } as unknown,
      INBOX_DOMAIN: "example.com",
      FROM_DOMAIN: "send.example.com",
      DEFAULT_FROM_LOCAL: "hello",
      ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
      ACCESS_AUD: "aud",
    } as unknown as Env;

    await worker.email!(makeMessage(rawWithAttachments(0)), env, makeCtx());

    // Threading is a nicety; delivery is not.
    expect(inserts).toHaveLength(1);
  });

  it("still stores the raw message and delivers normally with no attachments", async () => {
    const seen: string[] = [];
    const { env, inserts } = makeEnv(async (key: string) => {
      seen.push(key);
      return undefined;
    });

    await worker.email!(makeMessage(rawWithAttachments(0)), env, makeCtx());

    expect(seen.some((k) => k.startsWith("raw/"))).toBe(true);
    expect(inserts).toHaveLength(1);
  });
});
