// A filter acts on the message that just arrived, never on the conversation it
// was threaded into. Threading is driven by References, which the sender picks,
// so thread-wide filter actions let one inbound message refile mail it has
// nothing to do with.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../push", async (original) => ({
  ...(await original<typeof import("../push")>()),
  sendPushToAll: vi.fn(async () => ({ sent: 0, removed: 0 })),
}));

import { sendPushToAll } from "../push";
import { makeSqliteEnv, deliver, eml, type SqliteEnv } from "./sqlite_env";

const row = (t: SqliteEnv, messageId: string) =>
  t.db.prepare(`SELECT * FROM messages WHERE message_id=?`).get(messageId) as Record<string, unknown>;

function addFilter(t: SqliteEnv, field: string, value: string, action: string, position = 0) {
  t.db
    .prepare(`INSERT INTO filters (id, field, op, value, action, enabled, position, created) VALUES (?,?,?,?,?,1,?,1)`)
    .run(`f-${field}-${action}-${position}`, field, "contains", value, action, position);
}

const original = eml({
  From: "Alice <alice@example.com>",
  To: "me@example.com",
  Subject: "Project plan",
  "Message-ID": "<plan@example.com>",
});
const autoReply = eml({
  From: "Bob <bob@example.com>",
  To: "me@example.com",
  Subject: "Automatic reply: Project plan",
  "Message-ID": "<ooo@example.com>",
  References: "<plan@example.com>",
  "In-Reply-To": "<plan@example.com>",
});

describe("inbox filters are scoped to the new message", () => {
  beforeEach(() => vi.mocked(sendPushToAll).mockClear());

  it("trashes only the matching message, not the conversation it joined", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, original);
    addFilter(t, "subject", "automatic reply", "trash");
    await deliver(t.env, autoReply);

    const first = row(t, "<plan@example.com>");
    const second = row(t, "<ooo@example.com>");
    expect(second.thread_id).toBe(first.thread_id); // same conversation
    expect(first.state).toBe("inbox");
    expect(first.trashed_at).toBeNull();
    expect(second.state).toBe("trash");
    // Same transition as a manual trash: restorable to where it was.
    expect(second.pre_trash_state).toBe("inbox");
    expect(typeof second.trashed_at).toBe("number");
  });

  it("archives, stars and marks read on the message alone", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, original);
    addFilter(t, "from", "bob@", "star", 0);
    addFilter(t, "from", "bob@", "read", 1);
    addFilter(t, "from", "bob@", "archive", 2);
    await deliver(t.env, autoReply);

    const first = row(t, "<plan@example.com>");
    const second = row(t, "<ooo@example.com>");
    expect([first.state, first.starred, first.unread]).toEqual(["inbox", 0, 1]);
    expect([second.state, second.starred, second.unread]).toEqual(["archived", 1, 0]);
  });

  it("stays silent for a message a filter filed away", async () => {
    const t = await makeSqliteEnv();
    addFilter(t, "subject", "automatic reply", "trash");
    await deliver(t.env, autoReply);
    expect(sendPushToAll).not.toHaveBeenCalled();
  });

  it("still notifies for new mail in a conversation whose earlier mail was filed", async () => {
    const t = await makeSqliteEnv();
    addFilter(t, "subject", "automatic reply", "archive");
    await deliver(t.env, autoReply);
    vi.mocked(sendPushToAll).mockClear();

    await deliver(
      t.env,
      eml({
        From: "Alice <alice@example.com>",
        To: "me@example.com",
        Subject: "Re: Project plan",
        "Message-ID": "<followup@example.com>",
        References: "<ooo@example.com>",
      }),
    );
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
    expect(row(t, "<followup@example.com>").state).toBe("inbox");
  });

  it("puts the thread id in the push payload so the client can deep-link", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, original);
    const payload = vi.mocked(sendPushToAll).mock.calls[0][1] as Record<string, unknown>;
    const threadId = row(t, "<plan@example.com>").thread_id;
    expect(payload).toMatchObject({ title: "Alice", body: "Project plan", url: "/", tag: threadId, threadId });
    expect(typeof payload.threadId).toBe("string");
  });

  it("keeps the push payload inside one encrypted record however long the fields are", async () => {
    const t = await makeSqliteEnv();
    await deliver(
      t.env,
      eml({
        From: `${"N".repeat(5000)} <alice@example.com>`,
        To: "me@example.com",
        Subject: "S".repeat(5000),
        "Message-ID": `<${"m".repeat(300)}@example.com>`,
      }),
    );
    const payload = vi.mocked(sendPushToAll).mock.calls[0][1];
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThan(3000);
  });
});
