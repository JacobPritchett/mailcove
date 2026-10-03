// Reply-all, Cc/Bcc, the References chain, unsubscribe and the raw download,
// end to end through the real handlers on a real SQL engine.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { resetSendBucketsForTest } from "../index";
import { makeSqliteEnv, deliver, eml, api, type SqliteEnv } from "./sqlite_env";

const row = (t: SqliteEnv, where = "1=1") =>
  t.db.prepare(`SELECT * FROM messages WHERE ${where} ORDER BY rowid DESC LIMIT 1`).get() as Record<string, any>;
const parsedOf = async (t: SqliteEnv, id: string) => JSON.parse(new TextDecoder().decode(t.objects.get(`parsed/${id}.json`)!.bytes));

// The send limiter is per isolate, i.e. shared by every test in this file.
beforeEach(() => resetSendBucketsForTest());
afterEach(() => vi.unstubAllGlobals());

describe("stored headers at ingest", () => {
  it("keeps Reply-To, the References chain and the unsubscribe target with the body", async () => {
    const t = await makeSqliteEnv();
    await deliver(
      t.env,
      eml({
        From: "News <bounce@mailer.example>",
        "Reply-To": "Editors <editors@news.example>",
        To: "me@example.com",
        Subject: "Issue 42",
        "Message-ID": "<n42@news.example>",
        References: "<n40@news.example> <n41@news.example>",
        "List-Unsubscribe": "<https://news.example/u?x=1>, <mailto:unsub@news.example>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }),
    );
    const thread = await api(t.env, "GET", `/api/threads/${encodeURIComponent(row(t).thread_id)}`);
    const h = thread.body.messages[0].body.headers;
    expect(h.replyTo).toEqual([{ name: "Editors", address: "editors@news.example" }]);
    expect(h.references).toEqual(["<n40@news.example>", "<n41@news.example>"]);
    expect(h.unsubscribe).toEqual({
      url: "https://news.example/u?x=1",
      mailto: { address: "unsub@news.example", subject: "unsubscribe" },
      oneClick: true,
    });
  });
});

describe("POST /api/send with cc and bcc", () => {
  it("passes both to the binding, stores cc on the row and bcc only on our copy", async () => {
    const t = await makeSqliteEnv();
    const r = await api(t.env, "POST", "/api/send", {
      to: ["a@example.com"],
      cc: '"Doe, John" <john@example.com>, c@example.com',
      bcc: ["hidden@example.com"],
      subject: "hi",
      text: "body",
    });
    expect(r.status).toBe(200);
    expect(t.sent[0].cc).toEqual(['"Doe, John" <john@example.com>', "c@example.com"]);
    expect(t.sent[0].bcc).toEqual(["hidden@example.com"]);
    // Bcc must never become a header.
    expect(JSON.stringify(t.sent[0].headers)).not.toContain("hidden@example.com");
    const sentRow = row(t);
    expect(sentRow.msg_cc).toBe('"Doe, John" <john@example.com>, c@example.com');
    expect(sentRow.msg_to).toBe("a@example.com");
    expect((await parsedOf(t, sentRow.id)).headers.bcc).toEqual([{ name: "", address: "hidden@example.com" }]);
  });

  it("omits cc and bcc from the binding call when there are none", async () => {
    const t = await makeSqliteEnv();
    await api(t.env, "POST", "/api/send", { to: "a@example.com", subject: "hi", text: "body" });
    expect("cc" in t.sent[0]).toBe(false);
    expect("bcc" in t.sent[0]).toBe(false);
    expect(row(t).msg_cc).toBeNull();
  });

  it("caps recipients across to, cc and bcc together", async () => {
    const t = await makeSqliteEnv();
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}@example.com`);
    const r = await api(t.env, "POST", "/api/send", { to: many("t", 20), cc: many("c", 20), bcc: many("b", 11), subject: "x", text: "y" });
    expect(r.status).toBe(400);
    expect(t.sent).toHaveLength(0);
  });

  it("finds a message by a cc'd address in search, and never indexes bcc", async () => {
    const t = await makeSqliteEnv();
    await api(t.env, "POST", "/api/send", { to: "a@example.com", cc: "carol@example.com", bcc: "hidden@example.com", subject: "hi", text: "body" });
    expect((await api(t.env, "GET", "/api/messages?q=carol")).body.threads).toHaveLength(1);
    expect((await api(t.env, "GET", "/api/messages?q=to:carol")).body.threads).toHaveLength(1);
    expect((await api(t.env, "GET", "/api/messages?q=hidden")).body.threads).toHaveLength(0);
  });

  it("counts every address however it is packed, and refuses the overflow", async () => {
    const t = await makeSqliteEnv();
    const packed = Array.from({ length: 60 }, (_, i) => `v${i}@example.com`);
    for (const body of [
      { to: "a@example.com", bcc: [packed.join("; ")] },
      { to: "a@example.com", cc: [packed.join(", ")] },
      { to: [packed.join(",")] },
    ]) {
      const r = await api(t.env, "POST", "/api/send", { subject: "x", text: "y", ...body });
      expect(r.status).toBe(400);
    }
    expect(t.sent).toHaveLength(0);
  });

  it("refuses a structured recipient that hides a list or a header break", async () => {
    const t = await makeSqliteEnv();
    for (const cc of [
      [{ email: "v0@example.com, v1@example.com" }],
      [{ email: "a@example.com\r\nBcc: evil@example.com" }],
      ["a@example.com\r\nBcc: evil@example.com"],
      ["two@example.com three@example.com"],
    ]) {
      const r = await api(t.env, "POST", "/api/send", { to: "a@example.com", cc, subject: "x", text: "y" });
      expect(r.status).toBe(400);
    }
    expect(t.sent).toHaveLength(0);
  });

  it("cleans a structured display name and survives a non-string one", async () => {
    const t = await makeSqliteEnv();
    const r = await api(t.env, "POST", "/api/send", {
      to: [{ name: "X\r\nBcc: evil@example.com", email: "a@example.com" }],
      cc: [{ name: { a: 1 }, email: "c@example.com" }],
      subject: "x",
      text: "y",
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(t.sent[0])).not.toMatch(/\\r|\\n/);
    expect(t.sent[0].cc).toEqual([{ email: "c@example.com" }]);
  });
});

describe("References on a reply", () => {
  it("sends the parent's chain plus the parent", async () => {
    const t = await makeSqliteEnv();
    await deliver(
      t.env,
      eml({
        From: "a@example.com",
        To: "me@example.com",
        Subject: "Re: plan",
        "Message-ID": "<three@example.com>",
        "In-Reply-To": "<two@example.com>",
        References: "<one@example.com> <two@example.com>",
      }),
    );
    await api(t.env, "POST", "/api/send", { to: "a@example.com", subject: "Re: plan", text: "ok", inReplyTo: "<three@example.com>", threadId: row(t).thread_id });
    const headers = t.sent[0].headers as Record<string, string>;
    expect(headers["In-Reply-To"]).toBe("<three@example.com>");
    expect(headers.References).toBe("<one@example.com> <two@example.com> <three@example.com>");
  });

  it("ignores a stranger's duplicate Message-ID, and anything in another thread", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "plan", "Message-ID": "<real@example.com>", References: "<root@example.com>" }));
    const threadId = row(t).thread_id;
    // Same Message-ID, an old date to sort first, and planted References.
    await deliver(t.env, eml({ From: "evil@example.net", To: "me@example.com", Subject: "dup", "Message-ID": "<real@example.com>", Date: "Mon, 01 Jan 2001 00:00:00 +0000", References: "<victim-1@corp.example> <victim-2@corp.example>" }));
    await api(t.env, "POST", "/api/send", { to: "a@example.com", subject: "Re: plan", text: "ok", inReplyTo: "<real@example.com>", threadId });
    const refs = (t.sent[0].headers as Record<string, string>).References;
    expect(refs).toBe("<root@example.com> <real@example.com>");
  });

  it("keeps the header short however long the stored chain is", async () => {
    const t = await makeSqliteEnv();
    const huge = `<${"x".repeat(19_000)}@example.com>`;
    const many = Array.from({ length: 29 }, (_, i) => `<${"m".repeat(200)}${i}@example.com>`).join(" ");
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "plan", "Message-ID": "<p@example.com>", References: `<root@example.com> ${huge} ${many}` }));
    await api(t.env, "POST", "/api/send", { to: "a@example.com", subject: "Re: plan", text: "ok", inReplyTo: "<p@example.com>", threadId: row(t).thread_id });
    const refs = (t.sent[0].headers as Record<string, string>).References;
    expect(refs.length).toBeLessThanOrEqual(2000);
    expect(refs).not.toContain("xxxx");
    expect(refs.startsWith("<root@example.com> ")).toBe(true);
    expect(refs.endsWith(" <p@example.com>")).toBe(true);
  });

  it("falls back to the parent alone when it is not stored", async () => {
    const t = await makeSqliteEnv();
    await api(t.env, "POST", "/api/send", { to: "a@example.com", subject: "Re: x", text: "ok", inReplyTo: "<unknown@example.com>" });
    expect((t.sent[0].headers as Record<string, string>).References).toBe("<unknown@example.com>");
  });
});

describe("drafts with cc and bcc", () => {
  it("round-trips both", async () => {
    const t = await makeSqliteEnv();
    const put = await api(t.env, "PUT", "/api/drafts/draft-0001", { id: "draft-0001", to: "a@example.com", cc: "c@example.com", bcc: "b@example.com", subject: "s", bodyText: "t" });
    expect(put.status).toBe(200);
    const got = await api(t.env, "GET", "/api/drafts/draft-0001");
    expect(got.body.cc).toBe("c@example.com");
    expect(got.body.bcc).toBe("b@example.com");
  });

  it("still saves on a database that predates the cc columns", async () => {
    const t = await makeSqliteEnv();
    // The table as it stood before migration 0016.
    t.db.exec(`DROP TABLE drafts;
      CREATE TABLE drafts (id TEXT PRIMARY KEY, thread_id TEXT, in_reply_to TEXT, msg_to TEXT, subject TEXT,
        body_text TEXT, body_json TEXT, from_local TEXT, from_domain TEXT, from_name TEXT, attachments TEXT,
        updated INTEGER NOT NULL);`);
    const put = await api(t.env, "PUT", "/api/drafts/draft-0002", { id: "draft-0002", to: "a@example.com", cc: "c@example.com", subject: "s", bodyText: "t" });
    expect(put.status).toBe(200);
    const got = await api(t.env, "GET", "/api/drafts/draft-0002");
    expect(got.body.to).toBe("a@example.com");
    expect(got.body.cc).toBe("");
  });
});

describe("POST /api/messages/:id/unsubscribe", () => {
  const PASS = { "Authentication-Results": "mx.cloudflare.net; dkim=pass header.d=news.example; dmarc=pass header.from=news.example" };
  const newsletter = (extra: Record<string, string>, auth: Record<string, string> = PASS) =>
    eml({ ...auth, From: "News <news@news.example>", To: "shop@example.com", Subject: "Issue", "Message-ID": "<n@news.example>", ...extra });

  it("POSTs the one-click body to the https endpoint without following redirects", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<https://news.example/u?x=1>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }), { to: "shop@example.com" });
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`);
    expect(r.body).toEqual({ ok: true, method: "one-click" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://news.example/u?x=1");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("List-Unsubscribe=One-Click");
    expect(init.redirect).toBe("manual");
  });

  it("reports a failing endpoint instead of claiming success", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<https://news.example/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const r = await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`);
    expect(r.status).toBe(502);
  });

  it("refuses a one-click endpoint on a private address", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<https://127.0.0.1/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }));
    const fetchMock = vi.fn(async () => new Response(""));
    vi.stubGlobal("fetch", fetchMock);
    const r = await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`);
    expect(r.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the unsubscribe mail from the address the newsletter was delivered to", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<mailto:unsub@news.example?subject=remove>" }), { to: "shop@example.com" });
    const r = await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`);
    expect(r.body).toEqual({ ok: true, method: "mailto" });
    expect(t.sent[0].to).toBe("unsub@news.example");
    expect(t.sent[0].subject).toBe("remove");
    expect(JSON.stringify(t.sent[0])).toContain("shop@");
  });

  it("hands the link back when the endpoint redirects, instead of claiming success", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<https://news.example/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 302, headers: { location: "https://news.example/login" } })));
    const r = await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`);
    expect(r.body).toEqual({ ok: true, method: "open", url: "https://news.example/u" });
  });

  it("takes no automatic action for mail that did not pass DMARC", async () => {
    const t = await makeSqliteEnv();
    const fetchMock = vi.fn(async () => new Response(""));
    vi.stubGlobal("fetch", fetchMock);
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<https://news.example/u>, <mailto:victim@target.example>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, {}));
    const r = await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`);
    expect(r.body).toEqual({ ok: true, method: "open", url: "https://news.example/u" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.sent).toHaveLength(0);
  });

  it("refuses to mail an unverified sender's chosen target when there is no link either", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<mailto:victim@target.example>" }, {}));
    expect((await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`)).status).toBe(409);
    expect(t.sent).toHaveLength(0);
  });

  it("does not unsubscribe as a different identity when the delivery address cannot send", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<mailto:unsub@news.example>" }), { to: "anything@unknown-domain.example" });
    expect((await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`)).status).toBe(409);
    expect(t.sent).toHaveLength(0);
  });

  it("drops a mailto subject that reads as a message", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<mailto:unsub@news.example?subject=URGENT%20wire%20funds%20to%20http%3A%2F%2Fevil.example%20now>" }), { to: "shop@example.com" });
    await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`);
    expect(t.sent[0].subject).toBe("unsubscribe");
  });

  it("hands a plain link back for the user to open", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, newsletter({ "List-Unsubscribe": "<https://news.example/prefs>" }));
    const r = await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`);
    expect(r.body).toEqual({ ok: true, method: "open", url: "https://news.example/prefs" });
  });

  it("is a 404 when the message offers no way to unsubscribe", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "hi", "Message-ID": "<p@example.com>" }));
    expect((await api(t.env, "POST", `/api/messages/${row(t).id}/unsubscribe`)).status).toBe(404);
    expect((await api(t.env, "POST", `/api/messages/nope/unsubscribe`)).status).toBe(404);
  });
});

describe("GET /api/messages/:id/raw", () => {
  it("downloads the original message, never rendered inline", async () => {
    const t = await makeSqliteEnv();
    const raw = eml({ From: "a@example.com", To: "me@example.com", Subject: "<script>x</script>", "Message-ID": "<r@example.com>" }, "<script>alert(1)</script>", "text/html");
    await deliver(t.env, raw);
    const r = await api(t.env, "GET", `/api/messages/${row(t).id}/raw`);
    expect(r.status).toBe(200);
    expect(r.body).toBe(raw);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="[A-Za-z0-9-]+\.eml"$/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("is a 404 for sent mail, which has no raw copy", async () => {
    const t = await makeSqliteEnv();
    await api(t.env, "POST", "/api/send", { to: "a@example.com", subject: "hi", text: "body" });
    expect((await api(t.env, "GET", `/api/messages/${row(t).id}/raw`)).status).toBe(404);
  });
});

describe("unsubscribeTarget", () => {
  it("accepts only public https on the default port, and never this app", async () => {
    const { unsubscribeTarget } = await import("../index");
    const ok = (u: string) => unsubscribeTarget(u, "inbox.example.com") !== null;
    expect(ok("https://news.example/u?x=1")).toBe(true);
    for (const bad of [
      "http://news.example/u",
      "https://news.example:8443/u",
      "https://news.example:22/",
      "https://localhost./u",
      "https://foo.localhost./u",
      "https://127.0.0.1/u",
      "https://[::1]/u",
      "https://intranet/u",
      "https://db.internal/u",
      "https://inbox.example.com/api/messages/mutate",
      "https://x.inbox.example.com/u",
      "https://user:pw@news.example/u",
    ]) {
      expect(ok(bad), bad).toBe(false);
    }
  });
});

describe("attachmentDisposition", () => {
  it("does not throw on a lone surrogate in a filename", async () => {
    const { attachmentDisposition } = await import("../index");
    const cd = attachmentDisposition("\ud83d.txt");
    expect(/^[\x20-\x7e]+$/.test(cd)).toBe(true);
    expect(cd).toContain("filename*=UTF-8''%EF%BF%BD.txt");
  });
});
