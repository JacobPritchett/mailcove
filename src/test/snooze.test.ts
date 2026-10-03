// Snooze: a thread leaves the inbox until a chosen time, then comes back at the
// top, unread. End to end on a real SQL engine.
import { describe, it, expect } from "vitest";
import worker from "../index";
import { makeSqliteEnv, deliver, eml, api, type SqliteEnv } from "./sqlite_env";

const HOUR = 3_600_000;
const mail = (subject: string, id: string, extra: Record<string, string> = {}) =>
  eml({ From: "Friend <f@friend.example>", To: "me@example.com", Subject: subject, "Message-ID": `<${id}@example.com>`, ...extra });
const list = async (t: SqliteEnv, view: string) =>
  ((await api(t.env, "GET", `/api/messages?view=${view}`)).body.threads as { subject: string }[]).map((x) => x.subject);
const threadOf = (t: SqliteEnv, subject: string) =>
  encodeURIComponent((t.db.prepare(`SELECT thread_id FROM messages WHERE subject=?`).get(subject) as { thread_id: string }).thread_id);
const rowOf = (t: SqliteEnv, subject: string) =>
  t.db.prepare(`SELECT * FROM messages WHERE subject=?`).get(subject) as Record<string, any>;
const snooze = (t: SqliteEnv, subject: string, until: number) =>
  api(t.env, "POST", `/api/threads/${threadOf(t, subject)}/mutate`, { action: "snooze", until });
const cron = (t: SqliteEnv, expr: string) =>
  worker.scheduled!({ cron: expr } as ScheduledController, t.env, {} as ExecutionContext);

describe("snooze", () => {
  it("hides the thread from the inbox, lists it under Snoozed, and counts it there", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Later", "a"));
    await deliver(t.env, mail("Now", "b"));
    expect((await snooze(t, "Later", Date.now() + HOUR)).status).toBe(200);
    expect(await list(t, "inbox")).toEqual(["Now"]);
    expect(await list(t, "snoozed")).toEqual(["Later"]);
    expect(await list(t, "all")).toEqual(expect.arrayContaining(["Later", "Now"]));
    const counts = (await api(t.env, "GET", "/api/counts")).body;
    expect(counts.inbox).toBe(1);
    expect(counts.snoozed).toBe(1);
    expect(counts.inboxUnread).toBe(1);
    const row = (await api(t.env, "GET", "/api/messages?view=snoozed")).body.threads[0];
    expect(row.snoozedUntil).toBeGreaterThan(Date.now());
  });

  it("refuses to snooze mail that is not in the inbox, and says so", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Filed", "a"));
    await api(t.env, "POST", `/api/threads/${threadOf(t, "Filed")}/mutate`, { action: "archive" });
    const r = await snooze(t, "Filed", Date.now() + HOUR);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/inbox/);
  });

  it("requires a sensible time", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Later", "a"));
    expect((await api(t.env, "POST", `/api/threads/${threadOf(t, "Later")}/mutate`, { action: "snooze" })).status).toBe(400);
    expect((await snooze(t, "Later", Date.now() - 1000)).status).toBe(400);
    expect((await snooze(t, "Later", Date.now() + 800 * 24 * HOUR)).status).toBe(400);
    expect((await api(t.env, "POST", `/api/threads/${threadOf(t, "Later")}/mutate`, { action: "snooze", until: "tomorrow" })).status).toBe(400);
    expect(await list(t, "inbox")).toEqual(["Later"]);
  });

  it("comes back by itself when the time passes, above newer mail", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Old but snoozed", "a", { Date: "Mon, 01 Jun 2026 10:00:00 +0000" }));
    await deliver(t.env, mail("Newer", "b", { Date: "Tue, 02 Jun 2026 10:00:00 +0000" }));
    await snooze(t, "Old but snoozed", Date.now() + HOUR);
    // Time passes: move the wake time into the past, as the clock would.
    t.db.prepare(`UPDATE messages SET snoozed_until=? WHERE subject='Old but snoozed'`).run(Date.now() - 1000);
    // Visible again before any cron has run, and sorted by when it woke.
    expect(await list(t, "inbox")).toEqual(["Old but snoozed", "Newer"]);
    expect(await list(t, "snoozed")).toEqual([]);
  });

  it("is marked unread and keeps its place once the cron has processed it", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Old but snoozed", "a", { Date: "Mon, 01 Jun 2026 10:00:00 +0000" }));
    await deliver(t.env, mail("Newer", "b", { Date: "Tue, 02 Jun 2026 10:00:00 +0000" }));
    await api(t.env, "POST", `/api/threads/${threadOf(t, "Old but snoozed")}/mutate`, { action: "read" });
    await snooze(t, "Old but snoozed", Date.now() + HOUR);
    t.db.prepare(`UPDATE messages SET snoozed_until=? WHERE subject='Old but snoozed'`).run(Date.now() - 1000);
    await cron(t, "*/5 * * * *");
    const row = rowOf(t, "Old but snoozed");
    expect(row.snoozed_until).toBeNull();
    expect(row.woke_at).toBeGreaterThan(0);
    expect(row.unread).toBe(1);
    expect(await list(t, "inbox")).toEqual(["Old but snoozed", "Newer"]);
    // Running again changes nothing.
    await cron(t, "*/5 * * * *");
    expect(rowOf(t, "Old but snoozed").woke_at).toBe(row.woke_at);
  });

  it("leaves a thread that is still snoozed alone when the cron runs", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Later", "a"));
    await snooze(t, "Later", Date.now() + HOUR);
    await cron(t, "*/5 * * * *");
    expect(await list(t, "snoozed")).toEqual(["Later"]);
  });

  it("the frequent cron does not run the daily purge", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Trashed long ago", "a"));
    await api(t.env, "POST", `/api/threads/${threadOf(t, "Trashed long ago")}/mutate`, { action: "trash" });
    t.db.prepare(`UPDATE messages SET trashed_at=1`).run();
    await cron(t, "*/5 * * * *");
    expect(rowOf(t, "Trashed long ago")).toBeDefined();
    await cron(t, "0 4 * * *");
    expect(rowOf(t, "Trashed long ago")).toBeUndefined();
  });

  it("can be woken early", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Later", "a"));
    await snooze(t, "Later", Date.now() + HOUR);
    await api(t.env, "POST", `/api/threads/${threadOf(t, "Later")}/mutate`, { action: "unsnooze" });
    expect(await list(t, "inbox")).toEqual(["Later"]);
    expect(rowOf(t, "Later").snoozed_until).toBeNull();
  });

  it("wakes when a new message arrives in the conversation", async () => {
    const t = await makeSqliteEnv();
    // Explicit dates: two deliveries in the same millisecond would tie for
    // "latest message" and make the expected subject a coin toss.
    await deliver(t.env, mail("Plan", "a", { Date: "Mon, 01 Jun 2026 10:00:00 +0000" }));
    await snooze(t, "Plan", Date.now() + HOUR);
    await deliver(t.env, mail("Re: Plan", "b", { "In-Reply-To": "<a@example.com>", Date: "Tue, 02 Jun 2026 10:00:00 +0000" }));
    expect(await list(t, "snoozed")).toEqual([]);
    expect(await list(t, "inbox")).toEqual(["Re: Plan"]);
    expect((await api(t.env, "GET", "/api/messages?view=inbox")).body.threads[0].count).toBe(2);
  });

  it("is not cancelled by new mail that gets filed away", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Plan", "a", { Date: "Mon, 01 Jun 2026 10:00:00 +0000" }));
    await snooze(t, "Plan", Date.now() + HOUR);
    await api(t.env, "POST", "/api/blocked", { address: "pest@pest.example" });
    await deliver(
      t.env,
      eml({ From: "Pest <pest@pest.example>", To: "me@example.com", Subject: "Re: Plan (junk)", "Message-ID": "<j@example.com>", "In-Reply-To": "<a@example.com>" }),
    );
    expect(await list(t, "snoozed")).toEqual(["Plan"]);
    expect(await list(t, "inbox")).toEqual([]);
  });

  it("comes back at the top when a real reply ends the snooze early", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Plan", "a", { Date: "Mon, 01 Jun 2026 10:00:00 +0000" }));
    await deliver(t.env, mail("Other", "o", { Date: "Wed, 03 Jun 2026 10:00:00 +0000" }));
    await snooze(t, "Plan", Date.now() + HOUR);
    await deliver(t.env, mail("Re: Plan", "b", { "In-Reply-To": "<a@example.com>", Date: "Tue, 02 Jun 2026 10:00:00 +0000" }));
    expect(await list(t, "inbox")).toEqual(["Re: Plan", "Other"]);
    expect((await api(t.env, "GET", "/api/messages?view=inbox")).body.threads[0].snoozedUntil ?? null).toBeNull();
  });

  it("does not announce a woken thread the inbox would not list", async () => {
    const t = await makeSqliteEnv();
    await api(t.env, "POST", "/api/send", { to: "a@example.com", subject: "Only mine", text: "x" });
    t.db.prepare(`UPDATE messages SET snoozed_until=5 WHERE subject='Only mine'`).run();
    const { wakeSnoozed } = await import("../store_mutations");
    expect(await wakeSnoozed(t.env, Date.now())).toEqual([]);
    expect(rowOf(t, "Only mine").snoozed_until).toBeNull();
  });

  it("is forgotten when the thread is archived or trashed", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, mail("Later", "a"));
    await snooze(t, "Later", Date.now() + HOUR);
    await api(t.env, "POST", `/api/threads/${threadOf(t, "Later")}/mutate`, { action: "trash" });
    await api(t.env, "POST", `/api/threads/${threadOf(t, "Later")}/mutate`, { action: "restore" });
    expect(await list(t, "inbox")).toEqual(["Later"]);
    expect(await list(t, "snoozed")).toEqual([]);
  });

  it("pages a view that mixes woken and ordinary threads without gaps", async () => {
    const t = await makeSqliteEnv();
    for (let i = 0; i < 7; i++) await deliver(t.env, mail(`M${i}`, `m${i}`, { Date: `Mon, 0${i + 1} Jun 2026 10:00:00 +0000` }));
    t.db.prepare(`UPDATE messages SET woke_at=? WHERE subject='M0'`).run(Date.now());
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { body: { threads: { subject: string }[]; nextCursor: string | null } } = await api(
        t.env, "GET", `/api/messages?view=inbox&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...r.body.threads.map((x) => x.subject));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["M0", "M6", "M5", "M4", "M3", "M2", "M1"]);
  });
});
