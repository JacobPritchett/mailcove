// Route-level wiring for outbound attachments: what reaches the send binding,
// what lands in R2/D1, and what must block a send outright.
import { describe, it, expect, vi } from "vitest";
import { handleFetch, resetSendBucketsForTest, type Env } from "../index";

const ctx = {} as ExecutionContext;
const auth = { Authorization: "Bearer secret-token", "content-type": "application/json" };

const DOMAIN_ROWS = [
  { domain: "example.com", zone_id: "z1", sending_domain: "example.com", receive_mode: "inbox", forward_copy_to: null, display_name: null },
];

function makeEnv() {
  const inserts: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          if (/INSERT INTO messages\b/i.test(sql)) inserts.push({ sql, params });
          return {
            run: async () => ({}),
            first: async () => null,
            all: async () => ({ results: [] }),
          };
        },
        all: async () => (/FROM domains\b/i.test(sql) ? { results: DOMAIN_ROWS } : { results: [] }),
        first: async () =>
          /FROM domains\b/i.test(sql) ? (DOMAIN_ROWS[0] ?? null) : null,
        run: async () => ({}),
      };
    },
  };
  const put = vi.fn(async (_key: string, _body?: unknown, _opts?: unknown) => undefined);
  const send = vi.fn(async (_msg: Record<string, unknown>) => ({ messageId: "<real@cf>" }));
  const env = {
    DB: db as unknown,
    MAILSTORE: { put } as unknown,
    EMAIL: { send } as unknown,
    INBOX_DOMAIN: "example.com",
    FROM_DOMAIN: "send.example.com",
    DEFAULT_FROM_LOCAL: "hello",
    AUTH_TOKEN: "secret-token",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
  } as unknown as Env;
  return { env, put, send, inserts };
}

const post = (body: unknown) =>
  new Request("https://inbox.example.com/api/send", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });

const base = { to: "someone@example.com", subject: "s", text: "t" };
const file = (over: Record<string, unknown> = {}) => ({
  filename: "report.pdf",
  type: "application/pdf",
  data: btoa("PDF-BYTES"),
  ...over,
});

describe("POST /api/send with attachments", () => {
  it("sends with no attachments unchanged", async () => {
    resetSendBucketsForTest();
    const { env, send } = makeEnv();

    const res = await handleFetch(post(base), env, ctx);

    expect(res.status).toBe(200);
    expect(send.mock.calls[0][0]).not.toHaveProperty("attachments");
  });

  it("passes decoded attachments to the send binding", async () => {
    resetSendBucketsForTest();
    const { env, send } = makeEnv();

    const res = await handleFetch(post({ ...base, attachments: [file()] }), env, ctx);

    expect(res.status).toBe(200);
    const sent = (send.mock.calls[0][0] as unknown as { attachments: { filename: string; type: string; content: Uint8Array; disposition: string }[] }).attachments;
    expect(sent).toHaveLength(1);
    expect(sent[0].filename).toBe("report.pdf");
    expect(sent[0].type).toBe("application/pdf");
    expect(sent[0].disposition).toBe("attachment");
    expect(new TextDecoder().decode(sent[0].content)).toBe("PDF-BYTES");
  });

  it("stores each attachment in R2 and records it in the parsed body", async () => {
    resetSendBucketsForTest();
    const { env, put, inserts } = makeEnv();

    await handleFetch(post({ ...base, attachments: [file(), file({ filename: "b.txt", type: "text/plain" })] }), env, ctx);

    const keys = put.mock.calls.map((c) => c[0] as string);
    const parsedKey = keys.find((k) => k.startsWith("parsed/"))!;
    const id = parsedKey.slice("parsed/".length, -".json".length);
    // Assert the SAME id ties the R2 objects, the parsed body and the D1 row.
    // A wildcard here would still pass if the attachment landed under a
    // different uuid, which is exactly what makes every download 404.
    expect(keys).toContain(`att/${id}/p0`);
    expect(keys).toContain(`att/${id}/p1`);
    expect(inserts[0].params[0]).toBe(id);

    // The sanitized type must reach R2, or downloads silently become
    // octet-stream even for well-formed files.
    const p0 = put.mock.calls.find((c) => c[0] === `att/${id}/p0`)!;
    expect((p0[2] as { httpMetadata?: { contentType?: string } })?.httpMetadata?.contentType)
      .toBe("application/pdf");

    const parsedCall = put.mock.calls.find((c) => /^parsed\//.test(c[0] as string));
    const parsed = JSON.parse(parsedCall![1] as string) as { attachments: { partId: string; name: string; size: number }[] };
    expect(parsed.attachments.map((a) => a.partId)).toEqual(["p0", "p1"]);
    expect(parsed.attachments[1].name).toBe("b.txt");
    expect(parsed.attachments[0].size).toBe("PDF-BYTES".length);
  });

  it("marks the sent row as having attachments", async () => {
    resetSendBucketsForTest();
    const { env, inserts } = makeEnv();

    await handleFetch(post({ ...base, attachments: [file()] }), env, ctx);

    // has_attachments is the 11th bound column; without it the Sent list shows
    // no paperclip even though the message carried a file.
    expect(inserts[0].params[10]).toBe(1);
  });

  it("leaves has_attachments 0 when there are none", async () => {
    resetSendBucketsForTest();
    const { env, inserts } = makeEnv();

    await handleFetch(post(base), env, ctx);

    expect(inserts[0].params[10]).toBe(0);
  });

  it("refuses to send at all when an attachment is corrupt", async () => {
    resetSendBucketsForTest();
    const { env, send, put } = makeEnv();

    const res = await handleFetch(post({ ...base, attachments: [file({ data: "!!!not base64" })] }), env, ctx);

    // Sending without the file would be worse than failing: the sender would
    // believe the recipient got it.
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses an oversized attachment before sending", async () => {
    resetSendBucketsForTest();
    const { env, send } = makeEnv();
    const big = btoa("A".repeat(6 * 1024 * 1024));

    const res = await handleFetch(post({ ...base, attachments: [file({ data: big })] }), env, ctx);

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/too large/);
    expect(send).not.toHaveBeenCalled();
  });


  it("rejects an oversized payload without decoding it", async () => {
    resetSendBucketsForTest();
    const { env, send } = makeEnv();
    // 40 MB of base64. Decoding before measuring would materialize this several
    // times over and can take out the isolate.
    const huge = "A".repeat(40 * 1024 * 1024);

    const res = await handleFetch(post({ ...base, attachments: [file({ data: huge })] }), env, ctx);

    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("sanitizes a header-injecting filename on the way to the binding", async () => {
    resetSendBucketsForTest();
    const { env, send } = makeEnv();

    await handleFetch(
      post({ ...base, attachments: [file({ filename: "x.pdf\r\nBcc: attacker@evil.example" })] }),
      env,
      ctx,
    );

    const sent = (send.mock.calls[0][0] as unknown as { attachments: { filename: string }[] }).attachments;
    expect(sent[0].filename).not.toMatch(/[\r\n]/);
  });
});
