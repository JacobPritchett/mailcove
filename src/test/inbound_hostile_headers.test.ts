// Every header below is the sender's to choose. None of them may make ingest
// spend more than a moment: a Worker that runs out of CPU is killed, and the
// mail is lost with it.
import { describe, it, expect, vi } from "vitest";

vi.mock("../push", async (original) => ({
  ...(await original<typeof import("../push")>()),
  sendPushToAll: vi.fn(async () => ({ sent: 0, removed: 0 })),
}));

import { makeSqliteEnv, deliver, eml } from "./sqlite_env";

const N = 100_000;
const shapes: Record<string, string> = {
  "<": "<".repeat(N),
  ">": ">".repeat(N),
  '"': '"'.repeat(N),
  "<a": "<a".repeat(N / 2),
  ", ": "a, ".repeat(N / 3),
  "(": "(".repeat(N),
};

// NOT covered here, because it is not ours to fix: postal-mime's address
// parser is quadratic in the number of comma-separated entries in an address
// header (about 1 s for 100 KB, 3.5 s for 200 KB, inside PostalMime.parse).
const ADDRESS_HEADERS = new Set(["From", "To", "Cc"]);

describe("hostile inbound headers", () => {
  for (const header of ["From", "To", "Cc", "Subject", "References", "In-Reply-To", "Message-ID", "Date"]) {
    for (const [label, junk] of Object.entries(shapes)) {
      if (label === ", " && ADDRESS_HEADERS.has(header)) continue;
      it(`${header} made of ${N.toLocaleString("en-US")} x ${JSON.stringify(label)}`, async () => {
        const t = await makeSqliteEnv();
        t.db.prepare(`INSERT INTO filters (id, field, op, value, action, enabled, position, created) VALUES ('f','from','contains','zzz','star',1,0,1)`).run();
        const headers: Record<string, string> = {
          From: "Alice <alice@example.com>",
          To: "me@example.com",
          Subject: "s",
          "Message-ID": "<m@example.com>",
        };
        headers[header] = header === "From" ? `${junk} <alice@example.com>` : junk;
        const start = performance.now();
        await deliver(t.env, eml(headers));
        expect(performance.now() - start).toBeLessThan(1500);
        expect((t.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n).toBe(1);
      });
    }
  }
});
