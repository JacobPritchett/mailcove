import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listThreads,
  getCounts,
  mutateThread,
  mutateThreads,
  getMessage,
  send,
  getThread,
  getMe,
  attachmentUrl,
  listBlocked,
  addBlocked,
  removeBlocked,
  ApiError,
} from "@/lib/api";
import type { ThreadsResponse, ViewCounts, MessageDetail, ThreadResponse, Me } from "@/lib/types";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The last fetch call's [url, init] for assertions. */
function lastCall(): [string, RequestInit] {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const call = mock.mock.calls.at(-1)!;
  return [String(call[0]), (call[1] || {}) as RequestInit];
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listThreads", () => {
  it("GETs /api/messages?view=inbox with same-origin credentials and parses the body", async () => {
    const payload: ThreadsResponse = {
      threads: [],
      unread: 3,
      user: "alex@example.com",
    };
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(payload));

    const out = await listThreads({ view: "inbox" });
    expect(out).toEqual(payload);

    const [url, init] = lastCall();
    expect(url).toBe("/api/messages?view=inbox");
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    expect(init.credentials).toBe("same-origin");
  });

  it("appends &q= only when q is a non-empty trimmed string", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ threads: [], unread: 0, user: "x" }));
    await listThreads({ view: "trash", q: "hi" });
    // With the search goes the user's UTC offset, so date operators mean their days.
    expect(lastCall()[0]).toBe(`/api/messages?view=trash&q=hi&tz=${new Date().getTimezoneOffset()}`);
  });

  it("keeps the domain on a search, and drops only the category", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ threads: [], unread: 0, user: "x" }));
    await listThreads({ view: "inbox", q: "hi", category: "updates", domain: "example.com" });
    expect(lastCall()[0]).toBe(`/api/messages?view=inbox&q=hi&tz=${new Date().getTimezoneOffset()}&domain=example.com`);
  });

  it("sends both the category and the domain for a plain view", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ threads: [], unread: 0, user: "x" }));
    await listThreads({ view: "inbox", category: "updates", domain: "example.com" });
    expect(lastCall()[0]).toBe("/api/messages?view=inbox&category=updates&domain=example.com");
  });

  it("sends the page size and cursor when given", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ threads: [], unread: 0, user: "x" }));
    await listThreads({ view: "inbox", limit: 50, cursor: "d.5.t@x" });
    expect(lastCall()[0]).toBe("/api/messages?view=inbox&limit=50&cursor=d.5.t%40x");
  });

  it("omits q when it is an empty or whitespace-only string", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ threads: [], unread: 0, user: "x" }));
    await listThreads({ view: "inbox", q: "   " });
    expect(lastCall()[0]).toBe("/api/messages?view=inbox");
  });

  it("omits q when undefined", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ threads: [], unread: 0, user: "x" }));
    await listThreads({ view: "sent" });
    expect(lastCall()[0]).toBe("/api/messages?view=sent");
  });

  it("throws ApiError carrying the HTTP status on a non-OK response", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    await expect(listThreads({ view: "inbox" })).rejects.toBeInstanceOf(ApiError);
    await expect(listThreads({ view: "inbox" })).rejects.toMatchObject({ status: 500 });
  });
});

describe("getCounts", () => {
  it("GETs /api/counts and returns the view counts", async () => {
    const payload: ViewCounts = { inbox: 5, starred: 2, sent: 10, all: 17, trash: 3, inboxUnread: 2 };
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(payload));

    const out = await getCounts();
    expect(out).toEqual(payload);
    const [url, init] = lastCall();
    expect(url).toBe("/api/counts");
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    expect(init.credentials).toBe("same-origin");
  });
});

describe("mutateThread", () => {
  it("POSTs {action} to /api/threads/:id/mutate with URL-encoded id", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ ok: true }));
    const out = await mutateThread("<a@b>", "archive");
    expect(out).toEqual({ ok: true });

    const [url, init] = lastCall();
    expect(url).toBe("/api/threads/%3Ca%40b%3E/mutate");
    expect((init.method ?? "").toUpperCase()).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ action: "archive" });
    expect(init.credentials).toBe("same-origin");
  });

  it("throws ApiError on non-OK response", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(mutateThread("t1", "trash")).rejects.toMatchObject({ status: 404 });
  });
});

describe("mutateThreads (bulk)", () => {
  it("POSTs {threadIds, action} to /api/messages/mutate", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ ok: true, count: 3 }));
    const out = await mutateThreads(["t1", "t2", "t3"], "read");
    expect(out).toEqual({ ok: true, count: 3 });

    const [url, init] = lastCall();
    expect(url).toBe("/api/messages/mutate");
    expect((init.method ?? "").toUpperCase()).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ threadIds: ["t1", "t2", "t3"], action: "read" });
  });
});

describe("snooze, bulk limits, and the block list", () => {
  const bodies = () =>
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      JSON.parse(String((c[1] as RequestInit).body)),
    );

  it("sends the snooze time with a single and a bulk snooze", async () => {
    (globalThis.fetch as any).mockImplementation(() => Promise.resolve(jsonResponse({ ok: true, count: 2 })));
    await mutateThread("t1", "snooze", 1_800_000_000_000);
    await mutateThreads(["t1", "t2"], "snooze", 1_800_000_000_000);
    expect(bodies()).toEqual([
      { action: "snooze", until: 1_800_000_000_000 },
      { threadIds: ["t1", "t2"], action: "snooze", until: 1_800_000_000_000 },
    ]);
  });

  it("splits a selection larger than the Worker's 200 per request, and adds up the counts", async () => {
    (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(jsonResponse({ ok: true, count: JSON.parse(String(init.body)).threadIds.length })),
    );
    const ids = Array.from({ length: 450 }, (_, i) => `t${i}`);
    const out = await mutateThreads(ids, "archive");
    expect(bodies().map((b) => b.threadIds.length)).toEqual([200, 200, 50]);
    expect(bodies().flatMap((b) => b.threadIds)).toEqual(ids);
    expect(out).toEqual({ ok: true, count: 450 });
  });

  it("says which threads were not changed when a later request of a split selection fails", async () => {
    let n = 0;
    (globalThis.fetch as any).mockImplementation(() =>
      Promise.resolve(++n === 1 ? jsonResponse({ ok: true, count: 200 }) : jsonResponse({ error: "boom" }, 502)),
    );
    const ids = Array.from({ length: 450 }, (_, i) => `t${i}`);
    const err = await mutateThreads(ids, "archive").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.failedIds).toEqual(ids.slice(200));
  });

  it("lists, adds and removes blocked senders, encoding the entry in the path", async () => {
    (globalThis.fetch as any).mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true, blocked: [], address: "@ads.example" })),
    );
    await listBlocked();
    expect(lastCall()[0]).toBe("/api/blocked");
    await addBlocked("@Ads.Example");
    expect(lastCall()[1].method).toBe("POST");
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ address: "@Ads.Example" });
    await removeBlocked("@ads.example");
    expect(lastCall()[0]).toBe("/api/blocked/%40ads.example");
    expect(lastCall()[1].method).toBe("DELETE");
  });

  it("surfaces the Worker's reason when a block is refused", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ error: "that is one of your own domains" }, 400));
    await expect(addBlocked("@example.com")).rejects.toMatchObject({
      status: 400,
      message: "that is one of your own domains",
    });
  });
});

describe("getMessage", () => {
  it("GETs /api/messages/:id (id encoded) and returns the detail", async () => {
    const detail: MessageDetail = {
      message: {
        id: "abc",
        thread_id: "t1",
        direction: "in",
        folder: "inbox",
        msg_from: "a@b.com",
        msg_to: "c@d.com",
        subject: "hi",
        snippet: "...",
        date: 123,
        unread: 1,
        has_attachments: 0,
      },
      body: { text: "hi", html: "", attachments: [] },
    };
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(detail));

    const out = await getMessage("a/b c");
    expect(out).toEqual(detail);
    expect(lastCall()[0]).toBe("/api/messages/a%2Fb%20c");
  });

  it("throws ApiError on 404", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(getMessage("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("send", () => {
  it("POSTs JSON to /api/send and returns the result", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ ok: true, id: "new1" }));
    const payload = { to: "x@y.com", subject: "Hi", text: "body" };
    const out = await send(payload);
    expect(out).toEqual({ ok: true, id: "new1" });

    const [url, init] = lastCall();
    expect(url).toBe("/api/send");
    expect((init.method ?? "").toUpperCase()).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toMatch(/application\/json/);
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(init.credentials).toBe("same-origin");
  });

  it("throws ApiError when the server rejects the send", async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse({ error: "send failed" }, 502));
    await expect(send({ to: "x@y.com", subject: "", text: "" })).rejects.toMatchObject({ status: 502 });
  });
});

describe("getThread", () => {
  it("GETs /api/threads/:id and returns the thread", async () => {
    const thread: ThreadResponse = { thread_id: "t1", messages: [] };
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(thread));
    const out = await getThread("t1");
    expect(out).toEqual(thread);
    expect(lastCall()[0]).toBe("/api/threads/t1");
  });
});

describe("getMe", () => {
  it("GETs /api/me and returns the identity", async () => {
    const me: Me = { email: "alex@example.com" };
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(me));
    const out = await getMe();
    expect(out).toEqual(me);
    expect(lastCall()[0]).toBe("/api/me");
  });
});

describe("attachmentUrl", () => {
  it("builds a same-origin attachment URL with the name encoded", () => {
    expect(attachmentUrl("id1", "report final.pdf")).toBe(
      "/api/attachments/id1/report%20final.pdf",
    );
  });

  it("encodes special characters in the name", () => {
    expect(attachmentUrl("id1", "a/b&c.txt")).toBe("/api/attachments/id1/a%2Fb%26c.txt");
  });

  it("encodes special characters in the id too", () => {
    expect(attachmentUrl("a/b", "file.txt")).toBe("/api/attachments/a%2Fb/file.txt");
    expect(attachmentUrl("a b", "file.txt")).toBe("/api/attachments/a%20b/file.txt");
  });
});

describe("ApiError", () => {
  it("exposes status and message", () => {
    const e = new ApiError(418, "teapot");
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(418);
    expect(e.message).toBe("teapot");
  });

  it("wraps a fetch network rejection in an ApiError with status 0", async () => {
    (globalThis.fetch as any).mockRejectedValue(new TypeError("fail"));
    await expect(getMe()).rejects.toBeInstanceOf(ApiError);
    await expect(getMe()).rejects.toMatchObject({ status: 0 });
  });
});
