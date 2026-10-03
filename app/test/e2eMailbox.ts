// A small in-memory mailbox behind page.route, for the e2e specs that need the
// list to behave like the real one: paged views, counts, and mutations that
// move threads between views. Not a spec itself (the Playwright config only
// picks up e2e-*.spec.ts).
import { devices, type Page, type Route } from "@playwright/test";

export interface FakeThread {
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
  date: number;
  state: "inbox" | "archived" | "trash";
  spam: boolean;
  unread: boolean;
  starred: boolean;
  snoozedUntil: number | null;
  direction: "in" | "out";
  html?: string;
  domain?: string;
  /** Remote images the Worker would report as blocked in this message. */
  blockedImages?: number;
  /** Others copied on the message (so Reply all has someone to add). */
  cc?: string;
  /** Extra fields for the thread's one message (headers, attachments, ...). */
  message?: Record<string, unknown>;
}

export interface Mailbox {
  threads: FakeThread[];
  blocked: { address: string; created: number }[];
  /** Every request seen, as "METHOD path?query". */
  requests: string[];
  /** Bodies of POST /api/send, in order. */
  sends: Record<string, unknown>[];
  /** Bodies of the mutate calls, in order. */
  mutations: { threadIds: string[]; action: string; until?: number }[];
  /** Add a thread at the top (new mail). */
  deliver(subject: string, from?: string): FakeThread;
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

export function makeThreads(n: number, now = Date.now()): FakeThread[] {
  return Array.from({ length: n }, (_, i) => ({
    thread_id: `t${n - i}`,
    from: `Sender ${n - i} <sender${n - i}@example.com>`,
    subject: `Thread ${n - i}`,
    snippet: `Snippet for thread ${n - i}`,
    // A minute apart, newest first.
    date: now - i * 60_000,
    state: "inbox" as const,
    spam: false,
    unread: i % 3 === 0,
    starred: false,
    snoozedUntil: null,
    direction: "in" as const,
  }));
}

function inView(t: FakeThread, view: string, now: number): boolean {
  const snoozed = t.snoozedUntil !== null && t.snoozedUntil > now;
  switch (view) {
    case "inbox": return t.direction === "in" && t.state === "inbox" && !snoozed;
    case "snoozed": return t.state === "inbox" && snoozed;
    case "starred": return t.starred && t.state !== "trash";
    case "sent": return t.direction === "out" && t.state !== "trash";
    case "all": return t.state !== "trash";
    case "trash": return t.state === "trash" && !t.spam;
    case "spam": return t.state === "trash" && t.spam;
    default: return false;
  }
}

function listRow(t: FakeThread) {
  return {
    thread_id: t.thread_id, id: `m-${t.thread_id}`, msg_from: t.from, msg_to: "me@example.com",
    subject: t.subject, snippet: t.snippet, date: t.date, sort_date: t.date,
    snoozedUntil: t.snoozedUntil, count: 1, anyUnread: t.unread ? 1 : 0, hasAttachments: 0,
    starred: t.starred ? 1 : 0, category: null, domain: t.domain ?? "example.com",
  };
}

function apply(t: FakeThread, action: string, until?: number) {
  switch (action) {
    case "archive": if (t.state !== "trash") { t.state = "archived"; t.snoozedUntil = null; } break;
    case "unarchive": if (t.state === "archived") t.state = "inbox"; break;
    case "trash": t.state = "trash"; t.spam = false; t.snoozedUntil = null; break;
    case "spam": t.state = "trash"; t.spam = true; t.snoozedUntil = null; break;
    case "unspam": if (t.state === "trash" && t.spam) { t.state = "inbox"; t.spam = false; } break;
    case "restore": if (t.state === "trash") { t.state = "inbox"; t.spam = false; } break;
    case "star": t.starred = true; break;
    case "unstar": t.starred = false; break;
    case "read": t.unread = false; break;
    case "unread": t.unread = true; break;
    case "snooze": if (t.state === "inbox") t.snoozedUntil = until ?? null; break;
    case "unsnooze": t.snoozedUntil = null; break;
  }
}

/** Route every /api call on `page` to an in-memory mailbox and return it. */
export async function stubMailbox(page: Page, threads: FakeThread[], opts: { pageDelayMs?: number } = {}): Promise<Mailbox> {
  const box: Mailbox = {
    threads,
    blocked: [],
    requests: [],
    sends: [],
    mutations: [],
    deliver(subject, from = "New Sender <new@example.com>") {
      const t: FakeThread = {
        thread_id: `new-${box.threads.length}-${subject.replace(/\W+/g, "-")}`,
        from, subject, snippet: "Just arrived", date: Date.now(), state: "inbox", spam: false,
        unread: true, starred: false, snoozedUntil: null, direction: "in",
      };
      box.threads.unshift(t);
      return t;
    },
  };

  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    box.requests.push(`${method} ${p}${url.search}`);
    const now = Date.now();

    if (p === "/api/me") return route.fulfill(json({ email: "me@example.com" }));
    if (p === "/api/counts") {
      const n = (view: string) => box.threads.filter((t) => inView(t, view, now)).length;
      return route.fulfill(json({
        inbox: n("inbox"), starred: n("starred"), sent: n("sent"), all: n("all"), trash: n("trash"),
        spam: n("spam"), snoozed: n("snoozed"),
        inboxUnread: box.threads.filter((t) => inView(t, "inbox", now) && t.unread).length,
        drafts: 0, domains: [],
      }));
    }
    if (p === "/api/messages" && method === "GET") {
      const view = url.searchParams.get("view") ?? "inbox";
      const q = url.searchParams.get("q");
      const domain = url.searchParams.get("domain");
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const cursor = url.searchParams.get("cursor");
      let rows = [...box.threads].sort((a, b) => b.date - a.date || (a.thread_id < b.thread_id ? 1 : -1));
      rows = q
        ? rows.filter((t) => t.state !== "trash" && `${t.subject} ${t.from}`.toLowerCase().includes(q.toLowerCase()))
        : rows.filter((t) => inView(t, view, now));
      if (domain) rows = rows.filter((t) => (t.domain ?? "example.com") === domain);
      if (cursor) {
        // "d.<date>.<id>" resumes after that row, exactly as the Worker's keyset does.
        const m = /^d\.(\d+)\.(.+)$/.exec(cursor);
        const o = /^o\.(\d+)$/.exec(cursor);
        if (m) {
          const date = Number(m[1]);
          const id = decodeURIComponent(m[2]);
          rows = rows.filter((t) => t.date < date || (t.date === date && t.thread_id < id));
        } else if (o) {
          rows = rows.slice(Number(o[1]));
        }
      }
      const pageRows = rows.slice(0, limit);
      const last = pageRows[pageRows.length - 1];
      const offset = cursor?.startsWith("o.") ? Number(cursor.slice(2)) : 0;
      const nextCursor =
        pageRows.length < limit || !last
          ? null
          : q
            ? `o.${offset + pageRows.length}`
            : `d.${last.date}.${encodeURIComponent(last.thread_id)}`;
      if (opts.pageDelayMs && cursor) await new Promise((r) => setTimeout(r, opts.pageDelayMs));
      return route.fulfill(json({ threads: pageRows.map(listRow), unread: 0, user: "me", nextCursor }));
    }
    if (p === "/api/messages/mutate" && method === "POST") {
      const b = req.postDataJSON() as { threadIds: string[]; action: string; until?: number };
      box.mutations.push(b);
      for (const t of box.threads) if (b.threadIds.includes(t.thread_id)) apply(t, b.action, b.until);
      if (b.action === "delete") box.threads = box.threads.filter((t) => !b.threadIds.includes(t.thread_id));
      return route.fulfill(json({ ok: true, count: b.threadIds.length }));
    }
    const mutate = /^\/api\/threads\/([^/]+)\/mutate$/.exec(p);
    if (mutate && method === "POST") {
      const id = decodeURIComponent(mutate[1]);
      const b = req.postDataJSON() as { action: string; until?: number };
      box.mutations.push({ threadIds: [id], action: b.action, until: b.until });
      if (b.action === "delete") box.threads = box.threads.filter((t) => t.thread_id !== id);
      else for (const t of box.threads) if (t.thread_id === id) apply(t, b.action, b.until);
      return route.fulfill(json({ ok: true }));
    }
    const thread = /^\/api\/threads\/([^/]+)$/.exec(p);
    if (thread && method === "GET") {
      const id = decodeURIComponent(thread[1]);
      const t = box.threads.find((x) => x.thread_id === id);
      if (!t) return route.fulfill(json({ error: "not found" }, 404));
      const addr = /<([^>]+)>/.exec(t.from)?.[1] ?? t.from;
      return route.fulfill(json({
        thread_id: id,
        messages: [{
          id: `m-${id}`, thread_id: id, direction: t.direction, folder: "inbox", msg_from: t.from,
          msg_to: "me@example.com", msg_cc: t.cc ?? null, subject: t.subject, snippet: t.snippet, date: t.date,
          unread: t.unread ? 1 : 0, has_attachments: 0, message_id: `<${id}@example.com>`, in_reply_to: null,
          state: t.state, starred: t.starred ? 1 : 0, from_addr: addr,
          body: { text: t.snippet, html: t.html ?? `<p>${t.snippet}</p>`, attachments: [] },
          remoteImageCount: t.blockedImages ?? 0,
          remoteShown: false,
          domain: t.domain ?? "example.com",
          envelope_to: "me@example.com",
          spam: t.spam ? 1 : 0,
          snoozed_until: t.snoozedUntil,
          ...t.message,
        }],
      }));
    }
    if (p === "/api/blocked" && method === "GET") return route.fulfill(json({ blocked: box.blocked }));
    if (p === "/api/blocked" && method === "POST") {
      const { address } = req.postDataJSON() as { address: string };
      const entry = String(address).trim().toLowerCase();
      if (!/^[^\s@]*@[a-z0-9.-]+\.[a-z]+$/.test(entry)) {
        return route.fulfill(json({ error: "enter an email address, or a domain written as @example.com" }, 400));
      }
      if (entry.endsWith("@example.org")) return route.fulfill(json({ error: "that is one of your own domains" }, 400));
      if (!box.blocked.some((b) => b.address === entry)) box.blocked.unshift({ address: entry, created: now });
      return route.fulfill(json({ ok: true, address: entry }));
    }
    if (p.startsWith("/api/blocked/") && method === "DELETE") {
      const entry = decodeURIComponent(p.slice("/api/blocked/".length));
      box.blocked = box.blocked.filter((b) => b.address !== entry);
      return route.fulfill(json({ ok: true }));
    }
    if (p === "/api/send" && method === "POST") {
      box.sends.push(req.postDataJSON() as Record<string, unknown>);
      return route.fulfill(json({ ok: true, id: "sent" }));
    }
    if (p === "/api/filters") return route.fulfill(json({ filters: [] }));
    if (p === "/api/contacts") return route.fulfill(json({ contacts: [] }));
    if (p === "/api/drafts") return route.fulfill(json({ drafts: [] }));
    if (p === "/api/identities") {
      return route.fulfill(json({
        identities: [{ domain: "example.com", sendingDomain: "send.example.com", displayName: "Me", signature: "" }],
        defaultLocal: "me",
        defaultDomain: "example.com",
      }));
    }
    return route.fulfill(json({ ok: true }));
  });
  return box;
}

/** A phone context for chromium: iPhone 13 metrics and touch, minus its WebKit default. */
export const PHONE = (({ defaultBrowserType: _engine, ...profile }) => profile)(devices["iPhone 13"]);
