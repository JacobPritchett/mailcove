// Two attachments on one message may share a filename ("image.png" twice is
// routine). The download route resolved by name, so both links returned the
// first file. `?part=<partId>` names the exact part.
import { describe, it, expect } from "vitest";
import { makeSqliteEnv, deliver, api, type SqliteEnv } from "./sqlite_env";

function rawWithTwoSameNamed(): string {
  const b = "BOUND";
  const part = (content: string) =>
    [
      `--${b}`,
      `Content-Type: text/plain; name="notes.txt"`,
      `Content-Disposition: attachment; filename="notes.txt"`,
      "",
      content,
      "",
    ].join("\r\n");
  return [
    "From: Alice <alice@example.com>",
    "To: me@example.com",
    "Subject: two files",
    "Message-ID: <two@example.com>",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain",
    "",
    "see attached",
    "",
    part("FIRST FILE"),
    part("SECOND FILE"),
    `--${b}--`,
    "",
  ].join("\r\n");
}

async function setup(): Promise<{ t: SqliteEnv; id: string }> {
  const t = await makeSqliteEnv();
  await deliver(t.env, rawWithTwoSameNamed());
  const row = t.db.prepare(`SELECT id FROM messages`).get() as { id: string };
  return { t, id: row.id };
}

const text = (body: unknown) => new TextDecoder().decode(body as Uint8Array);

async function download(t: SqliteEnv, path: string) {
  const { handleFetch } = await import("../index");
  const res = await handleFetch(
    new Request(`https://inbox.example.com${path}`, { headers: { Authorization: "Bearer secret-token" } }),
    t.env,
    {} as ExecutionContext,
  );
  return { status: res.status, text: text(new Uint8Array(await res.arrayBuffer())), headers: res.headers };
}

describe("GET /api/attachments/:id/:name?part=", () => {
  it("serves each same-named attachment by its part id", async () => {
    const { t, id } = await setup();
    const first = await download(t, `/api/attachments/${id}/notes.txt?part=p0`);
    const second = await download(t, `/api/attachments/${id}/notes.txt?part=p1`);
    expect(first.status).toBe(200);
    expect(first.text).toContain("FIRST FILE");
    expect(second.status).toBe(200);
    expect(second.text).toContain("SECOND FILE");
    // Still a forced download with the stored filename.
    expect(second.headers.get("Content-Disposition")).toBe('attachment; filename="notes.txt"');
    expect(second.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("keeps resolving by name when no part is given", async () => {
    const { t, id } = await setup();
    const res = await download(t, `/api/attachments/${id}/notes.txt`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("FIRST FILE");
  });

  it("rejects a malformed part id rather than using it as a storage key", async () => {
    const { t, id } = await setup();
    for (const part of ["", "p", "1", "p12345", "p1/../p0", "P1", "p1%00", "../raw"]) {
      const res = await api(t.env, "GET", `/api/attachments/${id}/notes.txt?part=${encodeURIComponent(part)}`);
      expect(res.status, part).toBe(400);
    }
  });

  it("is a 404 for a part the message does not have", async () => {
    const { t, id } = await setup();
    const res = await download(t, `/api/attachments/${id}/notes.txt?part=p7`);
    expect(res.status).toBe(404);
  });
});
