// End-to-end threading through the inbound handler, on a real SQL engine.
import { describe, it, expect } from "vitest";
import { makeSqliteEnv, deliver, eml, api, type SqliteEnv } from "./sqlite_env";

const rows = (t: SqliteEnv) =>
  t.db.prepare(`SELECT id, thread_id, direction, message_id FROM messages ORDER BY rowid`).all() as {
    id: string; thread_id: string; direction: string; message_id: string;
  }[];

describe("inbound threading", () => {
  // The boundary MX's verdict; eml() keeps header order, so this is the first.
  const DMARC_PASS = { "Authentication-Results": "mx.cloudflare.net; dmarc=pass header.from=example.com" };
  const DMARC_FAIL = { "Authentication-Results": "mx.cloudflare.net; dmarc=fail header.from=example.com" };

  async function sendToSelf(t: SqliteEnv) {
    const sent = await api(t.env, "POST", "/api/send", { to: "me@example.com", subject: "note to self", text: "remember" });
    expect(sent.status).toBe(200);
    const sentRow = rows(t)[0];
    expect(sentRow.message_id).toBe("<cf-1@send.example.com>");
    return sentRow;
  }
  const copy = (from: string, auth: Record<string, string>) =>
    eml({ ...auth, From: from, To: "me@example.com", Subject: "note to self", "Message-ID": "<cf-1@send.example.com>" }, "remember");

  it("files the inbound copy of mail I sent to my own address in the sent message's thread", async () => {
    const t = await makeSqliteEnv();
    const sentRow = await sendToSelf(t);
    // The same message comes back in through Email Routing, carrying the
    // Message-ID the platform assigned and the transport From it went out with.
    await deliver(t.env, copy("Mailcove <hello@send.example.com>", DMARC_PASS));
    const all = rows(t);
    expect(all).toHaveLength(2);
    expect(all[1].direction).toBe("in");
    expect(all[1].thread_id).toBe(sentRow.thread_id);
  });

  it("also accepts the identity address itself as the copy's From (apex-onboarded senders)", async () => {
    const t = await makeSqliteEnv();
    const sentRow = await sendToSelf(t);
    await deliver(t.env, copy("HELLO@Example.com", DMARC_PASS));
    expect(rows(t)[1].thread_id).toBe(sentRow.thread_id);
  });

  // Anyone who has received mail from this inbox knows its Message-ID. That
  // must not be a key to the thread it lives in.
  it("keeps an outsider reusing a sent Message-ID out of that thread: different From", async () => {
    const t = await makeSqliteEnv();
    const sentRow = await sendToSelf(t);
    await deliver(t.env, copy("Mallory <mallory@evil.example>", { "Authentication-Results": "mx.cloudflare.net; dmarc=pass header.from=evil.example" }));
    expect(rows(t)[1].thread_id).not.toBe(sentRow.thread_id);
  });

  it("keeps an outsider reusing a sent Message-ID out of that thread: spoofed From, DMARC fail", async () => {
    const t = await makeSqliteEnv();
    const sentRow = await sendToSelf(t);
    await deliver(t.env, copy("hello@send.example.com", DMARC_FAIL));
    await deliver(t.env, copy("hello@example.com", {}));
    const all = rows(t);
    expect(all[1].thread_id).not.toBe(sentRow.thread_id);
    expect(all[2].thread_id).not.toBe(sentRow.thread_id);
  });

  it("does not use the message's own id to join a thread via an INBOUND row", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "re", "Message-ID": "<child@example.com>", References: "<root@example.com>" }));
    // Same Message-ID, no references: must not be pulled into root's thread.
    await deliver(t.env, eml({ ...DMARC_PASS, From: "a@example.com", To: "me@example.com", Subject: "x", "Message-ID": "<child@example.com>" }));
    const all = rows(t);
    expect(all[0].thread_id).toBe("root@example.com");
    expect(all[1].thread_id).toBe("child@example.com");
  });

  it("a reply joins an existing thread whose id contains a slash, and that thread opens", async () => {
    const t = await makeSqliteEnv();
    t.db
      .prepare(`INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, subject, date, message_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run("old1", "a/b@example.com", "in", "inbox", "a@example.com", "me@example.com", "legacy", 1, "<other@example.com>");
    await t.env.MAILSTORE.put("parsed/old1.json", JSON.stringify({ text: "old", html: "", attachments: [] }));
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "Re: legacy", "Message-ID": "<new@example.com>", References: "<a/b@example.com>" }));
    expect(rows(t)[1].thread_id).toBe("a/b@example.com");
    const res = await api(t.env, "GET", `/api/threads/${encodeURIComponent("a/b@example.com")}`);
    expect(res.status).toBe(200);
    expect(res.body.thread_id).toBe("a/b@example.com");
    expect(res.body.messages).toHaveLength(2);
  });

  it("still links a reply to its parent ahead of anything else", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "hi", "Message-ID": "<one@example.com>" }));
    await deliver(
      t.env,
      eml({ From: "a@example.com", To: "me@example.com", Subject: "Re: hi", "Message-ID": "<two@example.com>", "In-Reply-To": "<one@example.com>" }),
    );
    const all = rows(t);
    expect(all[1].thread_id).toBe(all[0].thread_id);
  });

  it("gives unrelated mail its own thread", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "one", "Message-ID": "<one@example.com>" }));
    await deliver(t.env, eml({ From: "b@example.com", To: "me@example.com", Subject: "two", "Message-ID": "<two@example.com>" }));
    const all = rows(t);
    expect(all[1].thread_id).not.toBe(all[0].thread_id);
  });

  it("never stores a thread id the API cannot address", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "dots", "Message-ID": "<..>" }));
    const [row] = rows(t);
    expect(row.thread_id).toBe(row.id); // fell back to the internal uuid
    const res = await api(t.env, "GET", `/api/threads/${encodeURIComponent(row.thread_id)}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });
});
