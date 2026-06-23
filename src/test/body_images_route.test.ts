import { describe, it, expect } from "vitest";
import { handleFetch, type Env } from "../index";

function makeEnv() {
  const row = { id: "m1", msg_from: "a@b.com", dmarc_pass: 0 };
  const db = { prepare: (sql: string) => ({ bind: () => ({ first: async () => (/FROM messages/.test(sql) ? row : null), run: async () => ({}), all: async () => ({ results: [] }) }) }) };
  const r2 = { get: async (k: string) => (k === "parsed/m1.json" ? { json: async () => ({ html: `<img src="https://cdn.test/a.png">`, text: "", attachments: [] }) } : null) };
  return { DB: db as unknown, MAILSTORE: r2 as unknown, IMG_PROXY_SECRET: "s", AUTH_TOKEN: "tok", ACCESS_TEAM_DOMAIN: "x", ACCESS_AUD: "a" } as unknown as Env;
}
const ctx = {} as ExecutionContext;

// [skipIf-gated] route goes through rewriteMessageHtml -> HTMLRewriter (workerd-only).
describe.skipIf(typeof HTMLRewriter === "undefined")("/api/messages/:id/body?images=1", () => {
  it("returns html with the remote image proxied + no-store", async () => {
    const res = await handleFetch(
      new Request("https://inbox.example.com/api/messages/m1/body?images=1", { headers: { Authorization: "Bearer tok" } }),
      makeEnv(), ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const b = (await res.json()) as { html: string; remoteShown: boolean };
    expect(b.remoteShown).toBe(true);
    expect(b.html).toContain("/api/media?t=");
    expect(b.html).not.toContain("cdn.test");
  });
});
