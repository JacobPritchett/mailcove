// Inbound mail on a database that has not taken migrations/0019-envelope-to.sql
// yet (a Worker deployed ahead of its migrations). The delivery address is a
// nicety; the message is not. On a real SQL engine.
import { describe, it, expect } from "vitest";
import { makeSqliteEnv, deliver, eml } from "./sqlite_env";

const MAIL = eml({ From: "a@example.org", To: "me@example.com", Subject: "hello", "Message-ID": "<pre@example.org>" });

describe("inbound mail before the envelope_to migration", () => {
  it("still stores the message, without the delivery address", async () => {
    const t = await makeSqliteEnv();
    t.db.exec(`ALTER TABLE messages DROP COLUMN envelope_to`);
    await deliver(t.env, MAIL, { to: "shop@example.com" });
    const stored = t.db.prepare(`SELECT subject, state, domain FROM messages`).all();
    expect(stored).toEqual([{ subject: "hello", state: "inbox", domain: "example.com" }]);
  });

  it("records the delivery address once the column exists", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, MAIL, { to: "Shop@Example.com" });
    const stored = t.db.prepare(`SELECT envelope_to FROM messages`).all();
    expect(stored).toEqual([{ envelope_to: "shop@example.com" }]);
  });

  it("does not swallow any other insert failure", async () => {
    const t = await makeSqliteEnv();
    t.db.exec(`ALTER TABLE messages DROP COLUMN r2_raw_key`);
    await expect(deliver(t.env, MAIL)).rejects.toThrow(/r2_raw_key/);
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM messages`).all()).toEqual([{ n: 0 }]);
  });
});
