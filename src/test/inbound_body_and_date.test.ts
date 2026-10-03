// What the inbound handler stores for a message's text, snippet, search body
// and date, end to end on a real SQL engine.
import { describe, it, expect } from "vitest";
import { clampInboundDate } from "../index";
import { getThread } from "../store";
import { makeSqliteEnv, deliver, eml, api, type SqliteEnv } from "./sqlite_env";

const only = (t: SqliteEnv) => t.db.prepare(`SELECT * FROM messages`).get() as Record<string, any>;
const stored = async (t: SqliteEnv, id: string) =>
  (await (await t.env.MAILSTORE.get(`parsed/${id}.json`))!.json()) as { text: string; html: string; textDerived?: boolean };

const NEWSLETTER =
  "<html><head><title>Weekly digest</title><style>.preheader{display:none;color:#fff}</style></head>" +
  "<body><div class=preheader>&zwnj;&nbsp;&zwnj;&nbsp;</div><h1>Big&nbsp;news</h1>" +
  "<p>Tom &amp; Jerry are back.</p><p>Read more &rarr;</p></body></html>";

describe("HTML-only inbound mail", () => {
  it("gets a readable snippet with no CSS and decoded entities", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "news@example.com", To: "me@example.com", Subject: "digest", "Message-ID": "<n@example.com>" }, NEWSLETTER, "text/html"));
    expect(only(t).snippet).toBe("Big news Tom & Jerry are back. Read more →");
  });

  it("stores derived text so a reply can quote it, and keeps the html untouched", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "news@example.com", To: "me@example.com", Subject: "digest", "Message-ID": "<n@example.com>" }, NEWSLETTER, "text/html"));
    const body = await stored(t, only(t).id);
    expect(body.text).toBe("Big news\n\nTom & Jerry are back.\n\nRead more →");
    expect(body.html).toContain("<style>");
  });

  // Derived text drops link destinations, so a client that prefers `text` must
  // be able to tell it apart from a text part the sender wrote.
  it("marks the stored body, and the thread payload, as having derived text", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "news@example.com", To: "me@example.com", Subject: "digest", "Message-ID": "<n@example.com>" }, '<p>See <a href="https://example.com/x">here</a></p>', "text/html"));
    const body = await stored(t, only(t).id);
    expect(body.text).toBe("See here");
    expect(body.textDerived).toBe(true);
    const thread = await getThread(t.env, only(t).thread_id);
    expect((thread.messages[0].body as { textDerived?: boolean }).textDerived).toBe(true);
  });

  it("does not mark a message that carried its own text part, or one with no body at all", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "plain", "Message-ID": "<p@example.com>" }, "just text"));
    const plain = await stored(t, only(t).id);
    expect("textDerived" in plain).toBe(false);

    const t2 = await makeSqliteEnv();
    await deliver(t2.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "empty", "Message-ID": "<e@example.com>" }, "", "text/html"));
    const empty = await stored(t2, only(t2).id);
    expect("textDerived" in empty).toBe(false);
  });

  it("indexes the visible text and not the stylesheet", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "news@example.com", To: "me@example.com", Subject: "digest", "Message-ID": "<n@example.com>" }, NEWSLETTER, "text/html"));
    const fts = t.db.prepare(`SELECT body FROM messages_fts`).get() as { body: string };
    expect(fts.body).toBe("Big news Tom & Jerry are back. Read more →");
    expect((await api(t.env, "GET", "/api/messages?q=jerry")).body.threads).toHaveLength(1);
    expect((await api(t.env, "GET", "/api/messages?q=preheader")).body.threads).toHaveLength(0);
  });

  it("leaves a message that has a text part exactly as sent", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "plain", "Message-ID": "<p@example.com>" }, "line one\r\nline <two> &amp; three"));
    const body = await stored(t, only(t).id);
    expect(body.text.trim()).toBe("line one\nline <two> &amp; three");
    expect(only(t).snippet).toBe("line one line <two> &amp; three");
  });

  it("ingests a hostile HTML body promptly instead of stalling", async () => {
    const t = await makeSqliteEnv();
    const start = performance.now();
    await deliver(t.env, eml({ From: "x@example.com", To: "me@example.com", Subject: "boom", "Message-ID": "<b@example.com>" }, "<".repeat(250_000), "text/html"));
    expect(performance.now() - start).toBeLessThan(1500);
    expect(only(t).subject).toBe("boom");
  });
});

describe("inbound message date", () => {
  const NOW = Date.parse("2026-06-08T12:00:00Z");
  const MIN = 60_000;

  it("keeps a past or current header date", () => {
    expect(clampInboundDate("Mon, 08 Jun 2026 11:00:00 +0000", NOW)).toBe(NOW - 60 * MIN);
    expect(clampInboundDate("Mon, 01 Jan 2001 00:00:00 +0000", NOW)).toBe(Date.parse("2001-01-01T00:00:00Z"));
    expect(clampInboundDate("2026-06-08T12:00:00.000Z", NOW)).toBe(NOW);
  });

  it("allows a few minutes of clock skew", () => {
    expect(clampInboundDate("Mon, 08 Jun 2026 12:04:00 +0000", NOW)).toBe(NOW + 4 * MIN);
  });

  it("clamps a future date to the receipt time", () => {
    expect(clampInboundDate("Mon, 08 Jun 2026 12:06:00 +0000", NOW)).toBe(NOW);
    expect(clampInboundDate("Thu, 01 Jan 2099 00:00:00 +0000", NOW)).toBe(NOW);
  });

  it("uses the receipt time for a missing or unparseable date", () => {
    expect(clampInboundDate(undefined, NOW)).toBe(NOW);
    expect(clampInboundDate("", NOW)).toBe(NOW);
    expect(clampInboundDate("not a date", NOW)).toBe(NOW);
  });

  it("a mail dated 2099 does not pin itself above newer mail", async () => {
    const t = await makeSqliteEnv();
    const before = Date.now();
    await deliver(t.env, eml({ From: "x@example.com", To: "me@example.com", Subject: "from the future", "Message-ID": "<f@example.com>", Date: "Thu, 01 Jan 2099 00:00:00 +0000" }));
    const row = only(t);
    expect(row.date).toBeGreaterThanOrEqual(before);
    expect(row.date).toBeLessThanOrEqual(Date.now());
  });
});
