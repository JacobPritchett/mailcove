import { describe, it, expect, vi } from "vitest";
import { handleFetch, type Env } from "../index";

// Build a mock Env for the /api/send path. The DB stub records every prepared
// SQL + bound params so we can assert what got stored. EMAIL.send is a vi.fn so
// we can inspect the headers passed to it AND control its return value (the
// platform-assigned messageId). Auth uses the AUTH_TOKEN bearer path.
function makeEnv(opts: {
  sendReturn: { messageId?: string } | undefined;
}) {
  const inserts: { sql: string; params: any[] }[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, params: [] as any[] };
      return {
        bind(...params: any[]) {
          call.params = params;
          // Match the messages table only — NOT the messages_fts search index.
          if (/INSERT INTO messages\b/i.test(sql)) inserts.push(call);
          return { run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) };
        },
      };
    },
  };
  const r2 = { put: vi.fn(async () => undefined) };
  const send = vi.fn(async (_msg: { headers: Record<string, string> }) => opts.sendReturn);
  const env = {
    DB: db as any,
    MAILSTORE: r2 as any,
    EMAIL: { send } as any,
    INBOX_DOMAIN: "example.com",
    FROM_DOMAIN: "send.example.com",
    DEFAULT_FROM_LOCAL: "hello",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    AUTH_TOKEN: "secret-token",
  } as unknown as Env;
  return { env, inserts, send, r2 };
}

function sendRequest(body: unknown) {
  return new Request("https://inbox.example.com/api/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer secret-token",
    },
    body: JSON.stringify(body),
  });
}

const ctx = {} as ExecutionContext;

describe("/api/send Message-ID handling", () => {
  it("does NOT set a platform-controlled Message-ID header on the outbound message", async () => {
    const { env, send } = makeEnv({ sendReturn: { messageId: "<real@cf>" } });
    const res = await handleFetch(sendRequest({ to: "x@y.com", text: "hi" }), env, ctx);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as { headers: Record<string, string> };
    expect(msg.headers).toBeDefined();
    // The only platform-controlled header must be absent.
    expect("Message-ID" in msg.headers).toBe(false);
  });

  it("stores the REAL messageId returned by send() as the sent row's message_id", async () => {
    const { env, inserts } = makeEnv({ sendReturn: { messageId: "<real@cf>" } });
    const res = await handleFetch(sendRequest({ to: "x@y.com", text: "hi" }), env, ctx);
    expect(res.status).toBe(200);
    expect(inserts.length).toBe(1);
    // INSERT column order: ... message_id (12th), in_reply_to (13th).
    const params = inserts[0].params;
    expect(params[11]).toBe("<real@cf>");
  });

  it("stores '' (graceful fallback) when send() returns no messageId — does not throw", async () => {
    const { env, inserts } = makeEnv({ sendReturn: undefined });
    const res = await handleFetch(sendRequest({ to: "x@y.com", text: "hi" }), env, ctx);
    expect(res.status).toBe(200);
    expect(inserts[0].params[11]).toBe("");
  });

  it("sends FROM the authorized sending subdomain but presents the apex identity via Reply-To", async () => {
    // The Cloudflare send_email binding only authorizes the onboarded sending
    // subdomain (FROM_DOMAIN = send.example.com). Sending FROM the apex throws
    // "email sending not authorized for subdomain 'example.com'". So the From
    // header lives on FROM_DOMAIN, while the user-facing identity — Reply-To —
    // lives on the apex INBOX_DOMAIN, which RECEIVES, so replies land in the inbox.
    const { env, send } = makeEnv({ sendReturn: { messageId: "<real@cf>" } });
    const res = await handleFetch(sendRequest({ to: "x@y.com", text: "hi" }), env, ctx);
    expect(res.status).toBe(200);
    const msg = send.mock.calls[0][0] as unknown as {
      from: { email: string };
      replyTo: string;
    };
    // From is the authorized transport sender…
    expect(msg.from.email).toBe("hello@send.example.com");
    expect(msg.from.email.split("@")[1]).toBe(env.FROM_DOMAIN);
    // …but Reply-To is the apex identity that receives mail.
    expect(msg.replyTo).toBe("hello@example.com");
    expect(msg.replyTo.split("@")[1]).toBe(env.INBOX_DOMAIN);
  });

  it("stores the sent row under the apex identity (msg_from + domain), not the transport subdomain", async () => {
    // The Sent view should show the clean apex identity the user composed as,
    // not the send.* transport detail.
    const { env, inserts } = makeEnv({ sendReturn: { messageId: "<real@cf>" } });
    const res = await handleFetch(sendRequest({ to: "x@y.com", text: "hi" }), env, ctx);
    expect(res.status).toBe(200);
    const { sql, params } = inserts[0];
    const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((s) => s.trim());
    expect(params[cols.indexOf("msg_from")]).toBe("hello@example.com");
    expect(params[cols.indexOf("domain")]).toBe("example.com");
  });

  it("persists state='inbox', starred=0 and domain on the sent row", async () => {
    const { env, inserts } = makeEnv({ sendReturn: { messageId: "<real@cf>" } });
    const res = await handleFetch(sendRequest({ to: "x@y.com", text: "hi" }), env, ctx);
    expect(res.status).toBe(200);
    const { sql, params } = inserts[0];
    const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((s) => s.trim());
    expect(params[cols.indexOf("state")]).toBe("inbox");
    expect(params[cols.indexOf("starred")]).toBe(0);
    expect(params[cols.indexOf("domain")]).toBe("example.com");
  });

  it("sets In-Reply-To and References (sanitized) on replies, but still no Message-ID", async () => {
    const { env, send, inserts } = makeEnv({ sendReturn: { messageId: "<real@cf>" } });
    const res = await handleFetch(
      sendRequest({ to: "x@y.com", text: "re", inReplyTo: "<parent@a.com>" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const msg = send.mock.calls[0][0] as { headers: Record<string, string> };
    expect(msg.headers["In-Reply-To"]).toBe("<parent@a.com>");
    expect(msg.headers["References"]).toBe("<parent@a.com>");
    expect("Message-ID" in msg.headers).toBe(false);
    // in_reply_to is persisted; message_id is the real one.
    expect(inserts[0].params[11]).toBe("<real@cf>");
    expect(inserts[0].params[12]).toBe("<parent@a.com>");
  });
});
