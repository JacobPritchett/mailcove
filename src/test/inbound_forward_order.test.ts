// The forward copy is the safety net for mail this inbox fails to store, so it
// must not sit behind the thing it protects against. And a single transient D1
// error must not cost a message.
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeSqliteEnv, deliver, eml, type SqliteEnv } from "./sqlite_env";

const RAW = eml({ From: "Alice <alice@example.com>", To: "me@example.com", Subject: "important", "Message-ID": "<i@example.com>" });
const COPY = "backup@elsewhere.example";

/** Make statements matching `pattern` throw for their first `times` executions. */
function failD1(t: SqliteEnv, pattern: RegExp, times: number, message = "D1_ERROR: Network connection lost.") {
  const real = t.env.DB;
  let left = times;
  let attempts = 0;
  (t.env as { DB: unknown }).DB = {
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      if (!pattern.test(sql)) return stmt;
      const wrap = (bound: any): any => ({
        bind: (...p: unknown[]) => wrap(bound.bind(...p)),
        all: () => bound.all(),
        first: () => bound.first(),
        async run() {
          attempts++;
          if (left > 0) {
            left--;
            throw new Error(message);
          }
          return bound.run();
        },
      });
      return wrap(stmt);
    },
  };
  return { attempts: () => attempts };
}

const count = (t: SqliteEnv) => (t.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
const INSERT = /INSERT INTO messages\b/;

describe("inbound forward copy and storage failures", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards the copy even when the message row can never be stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv({ FORWARD_COPY_TO: COPY });
    failD1(t, INSERT, Infinity);
    const forward = vi.fn(async () => {});

    // Ingest still fails loudly (Email Routing reports it), but the copy went out.
    await expect(deliver(t.env, RAW, { forward })).rejects.toThrow(/Network connection lost/);

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(COPY);
    expect(count(t)).toBe(0);
  });

  it("retries the insert once, so one transient D1 error does not lose the mail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv({ FORWARD_COPY_TO: COPY });
    const d1 = failD1(t, INSERT, 1);
    const forward = vi.fn(async () => {});

    await deliver(t.env, RAW, { forward });

    expect(d1.attempts()).toBe(2);
    expect(count(t)).toBe(1);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("gives up after the one retry rather than looping", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv({ FORWARD_COPY_TO: COPY });
    const d1 = failD1(t, INSERT, 2);
    await expect(deliver(t.env, RAW)).rejects.toThrow();
    expect(d1.attempts()).toBe(2);
    expect(count(t)).toBe(0);
  });

  it("treats a retry that collides with its own first attempt as stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv();
    // The first attempt commits but its response is lost; the retry then hits
    // the primary key it just wrote.
    const real = t.env.DB;
    let calls = 0;
    (t.env as { DB: unknown }).DB = {
      prepare(sql: string) {
        const stmt = real.prepare(sql);
        if (!INSERT.test(sql)) return stmt;
        const wrap = (bound: any): any => ({
          bind: (...p: unknown[]) => wrap(bound.bind(...p)),
          async run() {
            calls++;
            const r = await bound.run();
            if (calls === 1) throw new Error("D1_ERROR: Network connection lost.");
            return r;
          },
        });
        return wrap(stmt);
      },
    };
    await expect(deliver(t.env, RAW)).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(count(t)).toBe(1);
  });

  it("retries a forward that fails once, and sends exactly one copy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await makeSqliteEnv({ FORWARD_COPY_TO: COPY });
    let calls = 0;
    const delivered: string[] = [];
    await deliver(t.env, eml({ From: "a@example.com", To: "me@example.com", Subject: "retry me", "Message-ID": "<r@example.com>" }), {
      forward: async (address) => {
        if (++calls === 1) throw new Error("could not send email: Temporary Unknown error: transient error (421)");
        delivered.push(address);
      },
    });
    expect(calls).toBe(2);
    expect(delivered).toHaveLength(1);
  });

  it("stores the message when the forward itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await makeSqliteEnv({ FORWARD_COPY_TO: COPY });
    const forward = vi.fn(async () => {
      throw new Error("destination not verified");
    });
    await expect(deliver(t.env, RAW, { forward })).resolves.toBeUndefined();
    // The first attempt and the one retry, then it gives up.
    expect(forward).toHaveBeenCalledTimes(2);
    expect(count(t)).toBe(1);
  });

  it("forwards the copy when writing the raw message to R2 fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv({ FORWARD_COPY_TO: COPY });
    const realPut = t.env.MAILSTORE.put.bind(t.env.MAILSTORE);
    (t.env.MAILSTORE as { put: unknown }).put = async (key: string, ...rest: unknown[]) => {
      if (key.startsWith("raw/")) throw new Error("R2 unavailable");
      return (realPut as any)(key, ...rest);
    };
    const forward = vi.fn(async () => {});
    // Known and accepted: a raw-write failure still aborts ingest.
    await expect(deliver(t.env, RAW, { forward })).rejects.toThrow(/R2 unavailable/);
    expect(forward).toHaveBeenCalledWith(COPY);
    expect(count(t)).toBe(0);
  });

  it("falls back to the global copy address when the per-domain lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv({ FORWARD_COPY_TO: COPY });
    const real = t.env.DB;
    (t.env as { DB: unknown }).DB = {
      prepare(sql: string) {
        if (/FROM domains/.test(sql)) throw new Error("D1 unavailable");
        return real.prepare(sql);
      },
    };
    const forward = vi.fn(async () => {});
    await deliver(t.env, RAW, { forward });
    expect(forward).toHaveBeenCalledWith(COPY);
    expect(count(t)).toBe(1);
  });

  it("honors a per-domain override and a per-domain 'off'", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv({ FORWARD_COPY_TO: COPY });
    t.db.prepare(`INSERT INTO domains (domain, forward_copy_to, created) VALUES ('example.com', 'other@elsewhere.example', 1)`).run();
    t.db.prepare(`INSERT INTO domains (domain, forward_copy_to, created) VALUES ('quiet.example', '', 1)`).run();
    const forward = vi.fn(async () => {});
    await deliver(t.env, RAW, { forward });
    expect(forward).toHaveBeenCalledWith("other@elsewhere.example");

    forward.mockClear();
    await deliver(t.env, eml({ From: "a@example.com", To: "me@quiet.example", Subject: "x", "Message-ID": "<q@example.com>" }), { to: "me@quiet.example", forward });
    expect(forward).not.toHaveBeenCalled();
  });

  it("sends the copy exactly once on the ordinary path", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await makeSqliteEnv({ FORWARD_COPY_TO: COPY });
    const forward = vi.fn(async () => {});
    await deliver(t.env, RAW, { forward });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(count(t)).toBe(1);
  });
});
