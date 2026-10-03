import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseSearchQuery, buildSearchSql, contains } from "../searchQuery";
import { d1From, type SqliteDb } from "./sqlite_env";
import { searchThreads } from "../search";

const NOW = Date.UTC(2026, 9, 3, 12);
const DAY = 86_400_000;

describe("parseSearchQuery", () => {
  it("keeps plain words as AND-joined prefix atoms", () => {
    const p = parseSearchQuery("spice shipment", NOW);
    expect(p.match).toBe('"spice"* "shipment"*');
    expect(p.where).toEqual([]);
    expect(p.scope).toBe("live");
    expect(p.empty).toBe(false);
  });

  it("is empty for whitespace and bare punctuation", () => {
    expect(parseSearchQuery("   ", NOW).empty).toBe(true);
    expect(parseSearchQuery('"" :: --', NOW).empty).toBe(true);
  });

  it("turns from:/to:/subject: into literal substring predicates", () => {
    const p = parseSearchQuery("from:Maya to:100%_off subject:\"Cabin weekend\"", NOW);
    expect(p.match).toBeNull();
    expect(p.where).toHaveLength(3);
    // Lowercased for the case-insensitive compare; wildcards need no escaping
    // because nothing here is a pattern.
    expect(p.binds).toEqual(["maya", "100%_off", "100%_off", "cabin weekend"]);
    expect(p.where.join(" ")).not.toMatch(/LIKE/i);
    expect(p.empty).toBe(false);
  });

  it("understands has:, is:, in: and date operators", () => {
    const p = parseSearchQuery("has:attachment is:unread in:sent after:2026-01-15 before:2026/02/01 newer_than:7d", NOW);
    expect(p.where).toEqual([
      "m.has_attachments = 1",
      "m.unread = 1",
      "m.direction = 'out'",
      "m.date >= ?",
      "m.date < ?",
      "m.date >= ?",
    ]);
    expect(p.binds).toEqual([Date.UTC(2026, 0, 15), Date.UTC(2026, 1, 1), NOW - 7 * DAY]);
  });

  it("reads before:/after: as the user's days when given their offset", () => {
    // Phoenix is UTC-7: getTimezoneOffset() is 420, and local midnight is 07:00 UTC.
    expect(parseSearchQuery("after:2026-03-01", NOW, 420).binds).toEqual([Date.UTC(2026, 2, 1, 7)]);
    // Tokyo is UTC+9: offset -540, local midnight is 15:00 UTC the day before.
    expect(parseSearchQuery("before:2026-03-01", NOW, -540).binds).toEqual([Date.UTC(2026, 1, 28, 15)]);
    expect(parseSearchQuery("after:2026-03-01", NOW).binds).toEqual([Date.UTC(2026, 2, 1)]);
  });

  it("switches scope for in:trash only", () => {
    expect(parseSearchQuery("in:trash invoice", NOW).scope).toBe("trash");
    expect(parseSearchQuery("-in:trash invoice", NOW).scope).toBe("live");
    expect(parseSearchQuery("in:inbox invoice", NOW).scope).toBe("live");
  });

  it("negates an operator with a leading minus", () => {
    const p = parseSearchQuery("-from:newsletter", NOW);
    expect(p.where).toEqual(["NOT (instr(lower(COALESCE(m.msg_from,'')), ?) > 0)"]);
  });

  it("treats unknown operators and bad values as ordinary words", () => {
    expect(parseSearchQuery("re: invoice", NOW).match).toBe('"re"* "invoice"*');
    expect(parseSearchQuery("meeting 10:30", NOW).match).toBe('"meeting"* "10"* "30"*');
    expect(parseSearchQuery("is:banana", NOW).match).toBe('"is"* "banana"*');
    expect(parseSearchQuery("before:someday", NOW).match).toBe('"before"* "someday"*');
    expect(parseSearchQuery("foo:bar", NOW).where).toEqual([]);
  });

  it("matches a quoted phrase in order, without a prefix star", () => {
    expect(parseSearchQuery('"wood stove" cabin', NOW).match).toBe('"wood stove" "cabin"*');
  });

  it("cannot be made to emit FTS syntax", () => {
    const p = parseSearchQuery('a" OR b NEAR(c) * ^d col:x', NOW);
    // Every atom is a quoted token; operators typed by the user are just words.
    for (const atom of p.match!.match(/"[^"]*"\*?/g)!) expect(atom).toMatch(/^"[\p{L}\p{N} ]+"\*?$/u);
    expect(p.match).not.toMatch(/[()^]/);
  });

  it("caps free-text tokens and predicates", () => {
    const many = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    expect(parseSearchQuery(many, NOW).match!.split(" ")).toHaveLength(12);
    const ops = Array.from({ length: 40 }, (_, i) => `from:a${i}`).join(" ");
    expect(parseSearchQuery(ops, NOW).where).toHaveLength(12);
  });

  it("routes unsegmented-script terms to a substring scan", () => {
    const p = parseSearchQuery("打ち合わせ invoice", NOW);
    expect(p.likeTerms).toEqual(["打ち合わせ"]);
    expect(p.match).toBe('"invoice"*');
  });

  it("stays linear on hostile input", () => {
    const t0 = performance.now();
    parseSearchQuery("-".repeat(50_000) + 'a:"' + "x".repeat(50_000), NOW);
    parseSearchQuery('"'.repeat(50_001), NOW);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("contains", () => {
  it("is a literal, lowercased, NULL-safe substring test with no LIKE", () => {
    expect(contains("m.msg_cc", "A%_b")).toEqual({ sql: "instr(lower(COALESCE(m.msg_cc,'')), ?) > 0", bind: "a%_b" });
  });
});

describe("exclusions and scope", () => {
  it("collects -word and -\"phrase\" as exclusions, not as words to find", () => {
    const p = parseSearchQuery('stove -sale -"wood stove" well-known', NOW);
    expect(p.match).toBe('"stove"* "well"* "known"*');
    expect(p.notMatch).toEqual(['"sale"*', '"wood stove"']);
  });
  it("is empty when there are only exclusions", () => {
    expect(parseSearchQuery("-sale", NOW).empty).toBe(true);
  });
  it("widens to everything for in:anywhere, and keeps in:all to live mail", () => {
    expect(parseSearchQuery("x in:anywhere", NOW).scope).toBe("any");
    expect(parseSearchQuery("x in:all", NOW).scope).toBe("live");
    expect(parseSearchQuery("x in:junk", NOW).scope).toBe("spam");
  });
});

// The statement shape has two FTS5 traps (bm25 placement, bind order), so it is
// exercised against a real SQLite built from schema.sql rather than regexed.
describe("search against real SQLite", () => {
  let env: { DB: any };

  beforeAll(() => {
    const db = new DatabaseSync(":memory:");
    // vitest runs from the repo root.
    db.exec(readFileSync("schema.sql", "utf8"));
    const insert = db.prepare(
      `INSERT INTO messages (id, thread_id, direction, folder, msg_from, msg_to, msg_cc, subject, snippet, date, unread, has_attachments, state, starred, domain)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const fts = db.prepare(`INSERT INTO messages_fts (message_id, subject, participants, body) VALUES (?,?,?,?)`);
    const add = (m: {
      id: string; thread?: string; dir?: string; from: string; to: string; cc?: string; subject: string; body: string;
      daysAgo: number; unread?: number; att?: number; state?: string; starred?: number; domain?: string | null;
    }) => {
      insert.run(m.id, m.thread ?? m.id, m.dir ?? "in", "inbox", m.from, m.to, m.cc ?? null, m.subject, m.body.slice(0, 50),
        NOW - m.daysAgo * DAY, m.unread ?? 0, m.att ?? 0, m.state ?? "inbox", m.starred ?? 0, m.domain === undefined ? "example.com" : m.domain);
      fts.run(m.id, m.subject, [m.from, m.to, m.cc].filter(Boolean).join(" "), m.body);
    };
    add({ id: "a1", thread: "cabin", from: "Maya <maya@okafor.example>", to: "me@example.com", subject: "Cabin weekend", body: "We found a cabin with a wood stove", daysAgo: 3, unread: 1 });
    add({ id: "a2", thread: "cabin", dir: "out", from: "me@example.com", to: "maya@okafor.example", subject: "Re: Cabin weekend", body: "Count me in", daysAgo: 2 });
    add({ id: "b1", from: "Leasing <leasing@harbor.example>", to: "me@example.com", cc: "maya@okafor.example", subject: "Lease documents", body: "Attached is the lease", daysAgo: 10, att: 1, starred: 1 });
    add({ id: "c1", from: "Deals <deals@shop.example>", to: "me@example.org", subject: "100%_off stove sale", body: "stove stove stove", daysAgo: 40, state: "archived", domain: "example.org" });
    add({ id: "d1", from: "Spam <x@junk.example>", to: "me@example.com", subject: "cabin scam", body: "cabin cabin", daysAgo: 1, state: "trash" });
    add({ id: "e1", from: "田中 <tanaka@nihon.example>", to: "me@example.com", subject: "来週の打ち合わせについて", body: "火曜日の午後3時はいかがでしょうか", daysAgo: 5, domain: null });

    // The shared D1 shim, which also enforces D1's bind and LIKE limits.
    env = { DB: d1From(db as unknown as SqliteDb) };
  });

  const ids = async (q: string, opts = {}) =>
    (await searchThreads(env, q, 200, { now: NOW, ...opts })).map((r) => r.thread_id);

  it("ranks free text and collapses a thread to one row", async () => {
    const rows = await searchThreads(env, "cabin", 200, { now: NOW });
    expect(rows.map((r) => r.thread_id)).toEqual(["cabin"]);
    expect(rows[0].count).toBe(2);
    expect(rows[0].id).toBe("a2");
  });

  it("excludes trash unless asked, and then shows only trash", async () => {
    expect(await ids("cabin")).not.toContain("d1");
    expect(await ids("cabin in:trash")).toEqual(["d1"]);
  });

  it("distinguishes sender from recipient", async () => {
    expect(await ids("from:maya")).toEqual(["cabin"]);
    expect((await ids("to:maya")).sort()).toEqual(["b1", "cabin"]);
    expect(await ids("cc:maya")).toEqual(["b1"]);
  });

  it("answers operator-only queries newest first", async () => {
    expect(await ids("in:inbox")).toEqual(["cabin", "e1", "b1"]);
    expect(await ids("has:attachment")).toEqual(["b1"]);
    expect(await ids("is:starred")).toEqual(["b1"]);
    expect(await ids("is:unread")).toEqual(["cabin"]);
    expect(await ids("in:archive")).toEqual(["c1"]);
    expect(await ids("in:sent")).toEqual(["cabin"]);
  });

  it("combines free text with operators and dates", async () => {
    expect(await ids("stove from:maya")).toEqual(["cabin"]);
    expect(await ids("stove older_than:30d")).toEqual(["c1"]);
    expect(await ids("stove newer_than:30d")).toEqual(["cabin"]);
    expect(await ids("stove -from:maya")).toEqual(["c1"]);
  });

  it("matches LIKE wildcards literally", async () => {
    expect(await ids("subject:100%_off")).toEqual(["c1"]);
    expect(await ids("subject:%")).toEqual(["c1"]);
    expect(await ids("subject:_____________________________")).toEqual([]);
  });

  it("finds a word in the middle of an unsegmented-script run", async () => {
    expect(await ids("打ち合わせ")).toEqual(["e1"]);
    expect(await ids("火曜日")).toEqual(["e1"]);
    expect(await ids("存在しない")).toEqual([]);
  });

  it("narrows to a domain, folding legacy NULL rows into the default one", async () => {
    expect(await ids("stove", { domain: "example.org" })).toEqual(["c1"]);
    expect(await ids("in:inbox", { domain: "example.com" })).toEqual(["cabin", "b1"]);
    expect(await ids("in:inbox", { domain: "example.com", domainIncludesNull: true })).toEqual(["cabin", "e1", "b1"]);
  });

  it("pages with limit and offset", async () => {
    const page = async (offset: number) =>
      (await searchThreads(env, "in:inbox", 2, { now: NOW, offset })).map((r) => r.thread_id);
    expect(await page(0)).toEqual(["cabin", "e1"]);
    expect(await page(2)).toEqual(["b1"]);
  });

  it("excludes messages matching a negated word or phrase", async () => {
    expect(await ids("stove -cabin")).toEqual(["c1"]);
    expect(await ids('stove -"wood stove"')).toEqual(["c1"]);
    expect((await ids("in:inbox -lease")).sort()).toEqual(["cabin", "e1"]);
  });

  it("is case-insensitive and NULL-safe for operator values", async () => {
    expect(await ids("from:MAYA")).toEqual(["cabin"]);
    // b1 has a Cc, the others have NULL: a negated cc: must keep the NULL rows.
    expect((await ids("in:inbox -cc:maya")).sort()).toEqual(["cabin", "e1"]);
  });

  it("handles values far longer than D1's 50-byte LIKE limit", async () => {
    const long = "a-very-long-mailbox-name-that-goes-on-and-on@some-long-domain.example";
    expect(await ids(`from:${long}`)).toEqual([]);
    expect(await ids("打ち合わせについて打ち合わせについて打ち合わせについて")).toEqual([]);
    expect(await ids("来週の打ち合わせについて")).toEqual(["e1"]);
  });

  it("searches trash and junk too with in:anywhere", async () => {
    expect((await ids("cabin in:anywhere")).sort()).toEqual(["cabin", "d1"]);
  });

  it("builds a statement whose binds line up with its placeholders", () => {
    for (const q of ["stove", "from:maya", "打ち合わせ", "stove from:maya 打ち合わせ -sale -to:x in:trash", "in:anywhere -x y"]) {
      for (const domain of [undefined, "example.com"]) {
        const { sql, binds } = buildSearchSql(parseSearchQuery(q, NOW), { limit: 10, domain });
        expect(sql.split("?").length - 1).toBe(binds.length);
        expect(binds.length).toBeLessThanOrEqual(100);
      }
    }
  });
});
