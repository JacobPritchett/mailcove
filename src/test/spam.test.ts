// Junk: reporting, the Junk view, blocked senders, and the conservative
// automatic verdict. End to end on a real SQL engine.
import { describe, it, expect } from "vitest";
import { makeSqliteEnv, deliver, eml, api, type SqliteEnv } from "./sqlite_env";

const mail = (from: string, subject: string, id: string, extra: Record<string, string> = {}) =>
  eml({ From: from, To: "me@example.com", Subject: subject, "Message-ID": `<${id}@example.com>`, ...extra });
const threads = async (t: SqliteEnv, query: string) =>
  ((await api(t.env, "GET", `/api/messages?${query}`)).body.threads as { subject: string }[]).map((x) => x.subject);
const row = (t: SqliteEnv, subject: string) =>
  t.db.prepare(`SELECT * FROM messages WHERE subject=?`).get(subject) as Record<string, any>;

describe("reporting junk", () => {
  it("moves a thread to Junk, out of every other view and out of search", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Spammer <s@junk.example>", "WIN BIG", "a"));
    await deliver(t.env, mail("Friend <f@friend.example>", "Lunch", "b"));
    const id = row(t, "WIN BIG").thread_id;
    expect((await api(t.env, "POST", `/api/threads/${encodeURIComponent(id)}/mutate`, { action: "spam" })).status).toBe(200);

    expect(await threads(t, "view=inbox")).toEqual(["Lunch"]);
    expect(await threads(t, "view=all")).toEqual(["Lunch"]);
    expect(await threads(t, "view=spam")).toEqual(["WIN BIG"]);
    expect(await threads(t, "view=trash")).toEqual([]);
    expect(await threads(t, "q=win")).toEqual([]);
    expect(await threads(t, "q=win%20in:spam")).toEqual(["WIN BIG"]);
    expect(await threads(t, "q=win%20in:trash")).toEqual([]);
    const counts = (await api(t.env, "GET", "/api/counts")).body;
    expect(counts.spam).toBe(1);
    expect(counts.trash).toBe(0);
    expect(counts.inbox).toBe(1);
  });

  it("puts it back where it was with 'not junk'", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Friend <f@friend.example>", "Lunch", "b"));
    const id = encodeURIComponent(row(t, "Lunch").thread_id);
    await api(t.env, "POST", `/api/threads/${id}/mutate`, { action: "archive" });
    await api(t.env, "POST", `/api/threads/${id}/mutate`, { action: "spam" });
    await api(t.env, "POST", `/api/threads/${id}/mutate`, { action: "unspam" });
    const r = row(t, "Lunch");
    expect(r.state).toBe("archived");
    expect(r.spam).toBe(0);
    expect(r.trashed_at).toBeNull();
  });

  it("keeps junk as junk when its conversation is trashed and restored", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Friend <f@friend.example>", "Real", "a"));
    await deliver(t.env, mail("x@junk.example", "Re: Real", "b", { "In-Reply-To": "<a@example.com>" }));
    const junkRow = row(t, "Re: Real");
    t.db.prepare(`UPDATE messages SET state='trash', spam=1, pre_trash_state='inbox', trashed_at=5 WHERE id=?`).run(junkRow.id);
    const id = encodeURIComponent(junkRow.thread_id);
    await api(t.env, "POST", `/api/threads/${id}/mutate`, { action: "trash" });
    // The junk kept its mark and its purge clock.
    expect(row(t, "Re: Real").spam).toBe(1);
    expect(row(t, "Re: Real").trashed_at).toBe(5);
    await api(t.env, "POST", `/api/threads/${id}/mutate`, { action: "restore" });
    expect(row(t, "Real").state).toBe("inbox");
    expect(row(t, "Re: Real").state).toBe("trash");
    expect(row(t, "Re: Real").spam).toBe(1);
    expect(await threads(t, "view=inbox")).toEqual(["Real"]);
  });

  it("junks what was received in a conversation, not my own replies", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("x@junk.example", "Offer", "a"));
    const threadId = row(t, "Offer").thread_id;
    await api(t.env, "POST", "/api/send", { to: "x@junk.example", subject: "Re: Offer", text: "stop", threadId, inReplyTo: "<a@example.com>" });
    await api(t.env, "POST", `/api/threads/${encodeURIComponent(threadId)}/mutate`, { action: "spam" });
    expect(row(t, "Offer").spam).toBe(1);
    expect(row(t, "Re: Offer").spam).toBe(0);
    expect(row(t, "Re: Offer").state).toBe("inbox");
  });

  it("lets junk be deleted forever and purged like trash", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("x@junk.example", "One", "a"));
    const id = encodeURIComponent(row(t, "One").thread_id);
    await api(t.env, "POST", `/api/threads/${id}/mutate`, { action: "spam" });
    expect((await api(t.env, "POST", `/api/threads/${id}/mutate`, { action: "delete" })).status).toBe(200);
    expect(row(t, "One")).toBeUndefined();
  });
});

describe("blocked senders", () => {
  it("validates, lists and removes entries", async () => {
    const t = await makeSqliteEnv();
    expect((await api(t.env, "POST", "/api/blocked", { address: "Bad@Junk.Example" })).status).toBe(200);
    expect((await api(t.env, "POST", "/api/blocked", { address: "@spamdomain.example" })).status).toBe(200);
    expect((await api(t.env, "POST", "/api/blocked", { address: "not an address" })).status).toBe(400);
    expect((await api(t.env, "POST", "/api/blocked", { address: "@" })).status).toBe(400);
    const list = (await api(t.env, "GET", "/api/blocked")).body.blocked.map((b: { address: string }) => b.address);
    expect(list.sort()).toEqual(["@spamdomain.example", "bad@junk.example"]);
    expect((await api(t.env, "DELETE", `/api/blocked/${encodeURIComponent("bad@junk.example")}`)).status).toBe(200);
    expect((await api(t.env, "GET", "/api/blocked")).body.blocked).toHaveLength(1);
  });

  it("refuses to block one of my own domains", async () => {
    const t = await makeSqliteEnv();
    for (const address of ["@example.com", "hello@example.com", "@send.example.com", "x@mail.example.com", "@com"]) {
      expect((await api(t.env, "POST", "/api/blocked", { address })).status, address).toBe(400);
    }
  });

  it("refuses to block a suffix shared by unrelated senders", async () => {
    const t = await makeSqliteEnv();
    for (const address of ["@co.uk", "@com.au", "@github.io"]) {
      expect((await api(t.env, "POST", "/api/blocked", { address })).status, address).toBe(400);
    }
    expect((await api(t.env, "POST", "/api/blocked", { address: "@shop.co.uk" })).status).toBe(200);
    expect((await api(t.env, "POST", "/api/blocked", { address: "someone@co.uk" })).status).toBe(200);
  });

  it("sends mail from a blocked address or domain straight to Junk", async () => {
    const t = await makeSqliteEnv();
    await api(t.env, "POST", "/api/blocked", { address: "bad@junk.example" });
    await api(t.env, "POST", "/api/blocked", { address: "@spamdomain.example" });
    await deliver(t.env, mail("Bad <BAD@junk.example>", "Blocked address", "a"));
    await deliver(t.env, mail("Other <x@mail.spamdomain.example>", "Blocked subdomain", "b"));
    await deliver(t.env, mail("Fine <ok@junk.example>", "Same domain, other person", "c"));
    expect(row(t, "Blocked address").spam).toBe(1);
    expect(row(t, "Blocked address").state).toBe("trash");
    expect(row(t, "Blocked subdomain").spam).toBe(1);
    expect(row(t, "Same domain, other person").spam).toBe(0);
    expect(await threads(t, "view=inbox")).toEqual(["Same domain, other person"]);
  });

  it("matches the authenticated address, not an address typed into the display name", async () => {
    const t = await makeSqliteEnv();
    await api(t.env, "POST", "/api/blocked", { address: "boss@work.example" });
    // Someone ELSE using the blocked address as a display name is not blocked
    // by it (and must not be able to get a real sender's mail junked this way).
    await deliver(t.env, mail('"boss@work.example" <stranger@other.example>', "Spoofed name", "a"));
    expect(row(t, "Spoofed name").spam).toBe(0);
  });
});

describe("automatic junk verdict", () => {
  const withAi = (answer: string) => ({ AI: { run: async () => ({ response: answer }) } }) as never;
  const auth = (v: string) => ({ "Authentication-Results": `mx.cloudflare.net; ${v}` });

  it("junks mail the classifier calls spam when nothing vouches for it", async () => {
    const t = await makeSqliteEnv(withAi("spam"));
    await deliver(t.env, mail("Stranger <s@unknown.example>", "You won", "a", auth("dkim=none; spf=fail smtp.mailfrom=x.example; dmarc=none")));
    await deliver(t.env, mail("Stranger <s@unknown.example>", "No header at all", "b"));
    await deliver(t.env, mail("Bank <alerts@bank.example>", "Forged", "c", auth("dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=evil.example; dmarc=fail header.from=bank.example")));
    for (const subject of ["You won", "No header at all", "Forged"]) {
      expect(row(t, subject).spam, subject).toBe(1);
      expect(row(t, subject).state, subject).toBe("trash");
    }
    // The category column only ever holds a real category.
    expect(row(t, "You won").category).toBe("primary");
  });

  it("leaves authenticated mail in the inbox whatever the classifier thinks", async () => {
    const t = await makeSqliteEnv(withAi("spam"));
    await deliver(t.env, mail("New Vendor <billing@vendor.example>", "Your invoice", "a", auth("dkim=pass header.d=vendor.example; spf=pass smtp.mailfrom=vendor.example; dmarc=pass header.from=vendor.example")));
    await deliver(t.env, mail("Small Shop <hi@smallshop.example>", "Your code is 1234", "b", auth("dkim=none; spf=pass smtp.mailfrom=smallshop.example; dmarc=none")));
    await deliver(t.env, mail("Signed <a@signed.example>", "Signed only", "c", auth("dkim=pass header.d=signed.example; spf=none; dmarc=none")));
    for (const subject of ["Your invoice", "Your code is 1234", "Signed only"]) {
      expect(row(t, subject).spam, subject).toBe(0);
      expect(row(t, subject).state, subject).toBe("inbox");
    }
  });

  it("never junks a reply in a conversation I took part in", async () => {
    const t = await makeSqliteEnv(withAi("spam"));
    await api(t.env, "POST", "/api/send", { to: "list@group.example", subject: "question", text: "x" });
    const sent = t.db.prepare(`SELECT message_id FROM messages WHERE direction='out'`).get() as { message_id: string };
    await deliver(t.env, mail("New Person <new@elsewhere.example>", "Re: question", "a", { "In-Reply-To": sent.message_id }));
    expect(row(t, "Re: question").spam).toBe(0);
  });

  it("keeps mail in the inbox when the classifier fails or says anything but spam", async () => {
    const t = await makeSqliteEnv({ AI: { run: async () => { throw new Error("ai down"); } } } as never);
    await deliver(t.env, mail("Stranger <s@unknown.example>", "Hello", "a"));
    expect(row(t, "Hello").state).toBe("inbox");
    t.env.AI = { run: async () => ({ response: "This looks like spam to me" }) } as never;
    await deliver(t.env, mail("Stranger <s@unknown.example>", "Sentence", "b"));
    expect(row(t, "Sentence").state).toBe("inbox");
  });

  it("lets a rule that matched decide instead", async () => {
    const t = await makeSqliteEnv(withAi("spam"));
    await api(t.env, "POST", "/api/filters", { field: "subject", op: "contains", value: "keep me", action: "star" });
    await deliver(t.env, mail("Stranger <s@unknown.example>", "Please keep me", "a"));
    expect(row(t, "Please keep me").spam).toBe(0);
    expect(row(t, "Please keep me").starred).toBe(1);
  });

  it("still applies the user's rules when the block lookup fails", async () => {
    const t = await makeSqliteEnv(withAi("primary"));
    await api(t.env, "POST", "/api/filters", { field: "subject", op: "contains", value: "ruled", action: "star" });
    t.db.exec(`DROP TABLE blocked_senders`);
    await deliver(t.env, mail("Friend <f@friend.example>", "ruled mail", "a"));
    expect(row(t, "ruled mail").starred).toBe(1);
  });
});
