// Staged files used to die with the compose dialog. They are stored apart from
// the draft row because the body autosaves every 1.5s while the user types and
// the attachment set changes only when a file is added or removed - putting
// 10MB of base64 on the autosave path would re-upload everything per keystroke.
import { describe, it, expect } from "vitest";
import {
  parseDraftAttachments,
  manifestOf,
  parseManifest,
  draftAttachmentKey,
  putDraftAttachments,
  getDraftAttachments,
  deleteDraftAttachments,
  purgeOrphanedDraftAttachments,
} from "../draftAttachments";
import { MAX_ATTACHMENTS } from "../attachments";
import { DRAFTS_DDL } from "../drafts";
import { handleFetch, type Env } from "../index";

const b64 = (s: string) => btoa(s);
const HELLO = b64("hello");

/** In-memory R2 double: enough to prove keys, bodies and deletion. */
function makeR2() {
  const store = new Map<string, string>();
  return {
    store,
    bucket: {
      put: async (k: string, v: string) => void store.set(k, v),
      get: async (k: string) =>
        store.has(k) ? { text: async () => store.get(k)! } : null,
      delete: async (k: string) => void store.delete(k),
    } as unknown as R2Bucket,
  };
}

describe("parseDraftAttachments", () => {
  it("keeps the base64 the browser staged, byte for byte", () => {
    // Decoding only to re-encode would round-trip 5MB through
    // btoa/String.fromCharCode - wasteful, and a stack hazard on large files.
    const out = parseDraftAttachments([{ name: "a.txt", type: "text/plain", data: HELLO }]);
    expect(out[0].data).toBe(HELLO);
    expect(out[0].size).toBe(5);
  });

  it("sanitizes the filename and the mime type", () => {
    const out = parseDraftAttachments([
      { name: "../../etc/passwd", type: "text/plain\r\nX-Evil: 1", data: HELLO },
    ]);
    // What matters is that no path SEPARATOR survives - a literal ".." with
    // nothing to traverse is just an odd filename.
    expect(out[0].name).not.toMatch(/[/\\]/);
    expect(out[0].type).not.toContain("\n");
  });

  it("rejects data that is not decodable base64", () => {
    expect(() => parseDraftAttachments([{ name: "a", type: "text/plain", data: "!!!!" }])).toThrow();
  });

  it("rejects a non-string payload", () => {
    expect(() => parseDraftAttachments([{ name: "a", type: "text/plain", data: 42 }])).toThrow();
  });

  it("caps the number of files", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({
      name: "a.txt", type: "text/plain", data: HELLO,
    }));
    expect(() => parseDraftAttachments(many)).toThrow(/too many/i);
  });

  it("caps the total size across files", () => {
    // 3 x 4MB is under the per-file cap and over the 10MB total.
    const big = b64("x".repeat(4 * 1024 * 1024));
    const three = Array.from({ length: 3 }, () => ({ name: "a", type: "text/plain", data: big }));
    expect(() => parseDraftAttachments(three)).toThrow(/total/i);
  });

  it("treats absent attachments as an empty set, not an error", () => {
    expect(parseDraftAttachments(undefined)).toEqual([]);
    expect(parseDraftAttachments(null)).toEqual([]);
  });

  it("rejects a non-array", () => {
    expect(() => parseDraftAttachments("nope")).toThrow();
  });
});

describe("the manifest", () => {
  it("carries no bytes", () => {
    const items = parseDraftAttachments([{ name: "a.txt", type: "text/plain", data: HELLO }]);
    const meta = manifestOf(items);
    expect(meta[0]).toEqual({ name: "a.txt", type: "text/plain", size: 5 });
    expect(JSON.stringify(meta)).not.toContain(HELLO);
  });

  it("survives a corrupt column rather than failing the draft", () => {
    // A draft that cannot show its attachment list should still open.
    expect(parseManifest("{not json")).toEqual([]);
    expect(parseManifest("null")).toEqual([]);
    expect(parseManifest(null)).toEqual([]);
  });
});

describe("R2 storage", () => {
  it("round-trips the full set including bytes", async () => {
    const r2 = makeR2();
    const env = { MAILSTORE: r2.bucket };
    const items = parseDraftAttachments([{ name: "a.txt", type: "text/plain", data: HELLO }]);

    await putDraftAttachments(env, "draft-1", items);

    expect(r2.store.has(draftAttachmentKey("draft-1"))).toBe(true);
    expect(await getDraftAttachments(env, "draft-1")).toEqual(items);
  });

  it("clearing the set removes the object instead of storing an empty array", async () => {
    const r2 = makeR2();
    const env = { MAILSTORE: r2.bucket };
    await putDraftAttachments(env, "draft-1", parseDraftAttachments([{ name: "a", type: "text/plain", data: HELLO }]));

    await putDraftAttachments(env, "draft-1", []);

    expect(r2.store.size).toBe(0);
  });

  it("returns nothing for a missing or corrupt object rather than throwing", async () => {
    const r2 = makeR2();
    const env = { MAILSTORE: r2.bucket };
    expect(await getDraftAttachments(env, "absent")).toEqual([]);
    r2.store.set(draftAttachmentKey("bad"), "{not json");
    expect(await getDraftAttachments(env, "bad")).toEqual([]);
  });

  it("deleting is idempotent", async () => {
    const r2 = makeR2();
    const env = { MAILSTORE: r2.bucket };
    await deleteDraftAttachments(env, "absent");
    await deleteDraftAttachments(env, "absent");
    expect(r2.store.size).toBe(0);
  });
});

describe("the routes", () => {
  const ctx = {} as ExecutionContext;
  const auth = { Authorization: "Bearer secret-token", "content-type": "application/json" };

  function makeEnv(r2: R2Bucket, onSql?: (sql: string, binds: unknown[]) => void) {
    const db = {
      prepare(sql: string) {
        return {
          bind: (...binds: unknown[]) => {
            onSql?.(sql, binds);
            return { run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({}),
        };
      },
    } as unknown as D1Database;
    return {
      DB: db,
      MAILSTORE: r2,
      AUTH_TOKEN: "secret-token",
      ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
      ACCESS_AUD: "aud",
    } as unknown as Env;
  }

  const ID = "11111111-2222-3333-4444-555555555555";

  it("stores the bytes and writes the manifest to D1", async () => {
    const r2 = makeR2();
    const seen: Array<{ sql: string; binds: unknown[] }> = [];
    const env = makeEnv(r2.bucket, (sql, binds) => seen.push({ sql, binds }));

    const res = await handleFetch(
      new Request(`https://inbox.example.com/api/drafts/${ID}/attachments`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ attachments: [{ name: "a.txt", type: "text/plain", data: HELLO }] }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(r2.store.has(draftAttachmentKey(ID))).toBe(true);
    const update = seen.find((q) => /UPDATE drafts SET attachments/.test(q.sql));
    expect(update).toBeTruthy();
    // The column carries metadata only — the bytes must not be duplicated there.
    expect(String(update!.binds[0])).toContain("a.txt");
    expect(String(update!.binds[0])).not.toContain(HELLO);
  });

  it("clears the column when the last file is removed", async () => {
    const r2 = makeR2();
    const seen: Array<{ sql: string; binds: unknown[] }> = [];
    const env = makeEnv(r2.bucket, (sql, binds) => seen.push({ sql, binds }));

    await handleFetch(
      new Request(`https://inbox.example.com/api/drafts/${ID}/attachments`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ attachments: [] }),
      }),
      env,
      ctx,
    );

    const update = seen.find((q) => /UPDATE drafts SET attachments/.test(q.sql));
    expect(update!.binds[0]).toBeNull();
    expect(r2.store.size).toBe(0);
  });

  it("rejects an oversize set with 400 rather than storing it", async () => {
    const r2 = makeR2();
    const big = b64("x".repeat(6 * 1024 * 1024));
    const res = await handleFetch(
      new Request(`https://inbox.example.com/api/drafts/${ID}/attachments`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ attachments: [{ name: "a", type: "text/plain", data: big }] }),
      }),
      makeEnv(r2.bucket),
      ctx,
    );

    expect(res.status).toBe(400);
    expect(r2.store.size).toBe(0);
  });

  it("returns the bytes for a resume", async () => {
    const r2 = makeR2();
    const env = makeEnv(r2.bucket);
    await putDraftAttachments(
      { MAILSTORE: r2.bucket },
      ID,
      parseDraftAttachments([{ name: "a.txt", type: "text/plain", data: HELLO }]),
    );

    const res = await handleFetch(
      new Request(`https://inbox.example.com/api/drafts/${ID}/attachments`, { headers: auth }),
      env,
      ctx,
    );

    expect(await res.json()).toEqual({
      attachments: [{ name: "a.txt", type: "text/plain", size: 5, data: HELLO }],
    });
  });

  it("deleting a draft also deletes its bytes", async () => {
    const r2 = makeR2();
    const env = makeEnv(r2.bucket);
    await putDraftAttachments(
      { MAILSTORE: r2.bucket },
      ID,
      parseDraftAttachments([{ name: "a.txt", type: "text/plain", data: HELLO }]),
    );

    await handleFetch(
      new Request(`https://inbox.example.com/api/drafts/${ID}`, { method: "DELETE", headers: auth }),
      env,
      ctx,
    );

    // Otherwise every discarded draft leaves its files in R2 forever.
    expect(r2.store.size).toBe(0);
  });

});

describe("the lazy-create DDL", () => {
  it("declares the attachments column", () => {
    // ensureDraftsTable runs CREATE TABLE IF NOT EXISTS, so a fresh deployment
    // builds this shape and IF NOT EXISTS will never repair it afterwards.
    // Migrations only fix databases that already exist; the two are kept in
    // step by hand, and this is that check. The same drift broke the signature
    // feature entirely once.
    expect(DRAFTS_DDL).toContain("attachments");
  });
});

describe("surviving the pre-migration window", () => {
  // Workers Builds deploys code without applying D1 migrations, so there is a
  // real window where the `attachments` column does not exist yet.
  it("still lists drafts when the column is missing", async () => {
    const { listDrafts } = await import("../drafts");
    let attempts = 0;
    const db = {
      prepare(sql: string) {
        const hasCol = /attachments/.test(sql);
        return {
          all: async () => {
            attempts++;
            if (hasCol) throw new Error("no such column: attachments");
            return {
              results: [
                { id: "d1", thread_id: null, msg_to: "a@x.com", subject: "S", body_text: "b", updated: 1 },
              ],
            };
          },
        };
      },
    } as unknown as D1Database;

    const out = await listDrafts({ DB: db });

    // The catch-all used to turn this into "you have no drafts".
    expect(out).toHaveLength(1);
    expect(out[0].attachmentCount).toBe(0);
    expect(attempts).toBe(2);
  });
});

describe("the orphan sweep", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_700_000_000_000;

  /** R2 double with an uploaded timestamp per object. */
  function makeListableR2(objects: Array<{ key: string; ageMs: number }>) {
    const keys = new Set(objects.map((o) => o.key));
    return {
      keys,
      bucket: {
        list: async () => ({
          objects: objects
            .filter((o) => keys.has(o.key))
            .map((o) => ({ key: o.key, uploaded: new Date(NOW - o.ageMs) })),
        }),
        delete: async (k: string) => void keys.delete(k),
      } as unknown as R2Bucket,
    };
  }

  function makeDb(liveIds: string[], onBinds?: (b: unknown[]) => void) {
    return {
      prepare: () => ({
        bind: (...b: unknown[]) => {
          onBinds?.(b);
          return {
            all: async () => ({ results: liveIds.filter((id) => b.includes(id)).map((id) => ({ id })) }),
          };
        },
      }),
    } as unknown as D1Database;
  }

  it("deletes a blob whose draft is gone", async () => {
    const r2 = makeListableR2([{ key: "draftatt/gone.json", ageMs: 2 * DAY }]);

    const out = await purgeOrphanedDraftAttachments({ DB: makeDb([]), MAILSTORE: r2.bucket }, NOW);

    expect(out.purged).toBe(1);
    expect(r2.keys.size).toBe(0);
  });

  it("keeps a blob whose draft still exists", async () => {
    const r2 = makeListableR2([{ key: "draftatt/live.json", ageMs: 2 * DAY }]);

    const out = await purgeOrphanedDraftAttachments(
      { DB: makeDb(["live"]), MAILSTORE: r2.bucket },
      NOW,
    );

    expect(out.purged).toBe(0);
    expect(r2.keys.has("draftatt/live.json")).toBe(true);
  });

  it("will not touch a blob written recently", async () => {
    // Writes are row-then-bytes, but a sweep racing a save must never be the
    // reason a user loses a file. An orphan surviving one more day costs a few
    // KB; deleting a live attachment cannot be undone.
    const r2 = makeListableR2([{ key: "draftatt/fresh.json", ageMs: 60_000 }]);

    const out = await purgeOrphanedDraftAttachments({ DB: makeDb([]), MAILSTORE: r2.bucket }, NOW);

    expect(out.purged).toBe(0);
    expect(r2.keys.size).toBe(1);
  });

  it("never binds more than 100 parameters to one statement", async () => {
    // D1's limit is exactly 100 — verified live, where 101 fails with
    // "too many SQL variables". 150 candidates must become two statements.
    const objects = Array.from({ length: 150 }, (_, i) => ({
      key: `draftatt/d${i}.json`,
      ageMs: 2 * DAY,
    }));
    const r2 = makeListableR2(objects);
    const binds: number[] = [];

    await purgeOrphanedDraftAttachments(
      { DB: makeDb([], (b) => binds.push(b.length)), MAILSTORE: r2.bucket },
      NOW,
    );

    expect(binds.length).toBe(2);
    expect(Math.max(...binds)).toBeLessThanOrEqual(100);
  });

  it("does nothing when there is nothing old enough to consider", async () => {
    const r2 = makeListableR2([]);
    expect(
      (await purgeOrphanedDraftAttachments({ DB: makeDb([]), MAILSTORE: r2.bucket }, NOW)).purged,
    ).toBe(0);
  });
});
