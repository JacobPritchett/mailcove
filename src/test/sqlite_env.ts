// A real-SQL test double: D1 backed by node:sqlite (seeded from schema.sql) and
// R2 backed by a Map. The hand-rolled stubs elsewhere in this directory assert
// query SHAPE; this one lets a test assert what the queries actually DO, which
// is what matters for anything with a WHERE clause worth getting wrong.
//
// node:sqlite and node:fs are loaded through a string-typed specifier because
// the worker tsconfig deliberately carries no Node types.
import worker, { handleFetch, type Env } from "../index";

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const nodeModule = (name: string): Promise<any> => import(/* @vite-ignore */ name);

/** Absolute path of a file relative to the repository root (vitest's cwd). */
async function repoPath(relative: string): Promise<string> {
  const [path, proc] = await Promise.all([nodeModule("node:path"), nodeModule("node:process")]);
  return path.join(proc.cwd(), relative);
}

/** Read a file relative to the repository root. */
export async function readRepoFile(relative: string): Promise<string> {
  const fs = await nodeModule("node:fs");
  return fs.readFileSync(await repoPath(relative), "utf8");
}

/** Sorted file names in a directory relative to the repository root. */
export async function listRepoDir(relative: string): Promise<string[]> {
  const fs = await nodeModule("node:fs");
  return (fs.readdirSync(await repoPath(relative)) as string[]).sort();
}

export async function openSqlite(): Promise<SqliteDb> {
  const { DatabaseSync } = await nodeModule("node:sqlite");
  return new DatabaseSync(":memory:") as SqliteDb;
}

/** D1 refuses a statement with more than this many bound parameters. */
const D1_MAX_BINDS = 100;
/** D1's cap on a LIKE or GLOB pattern, in bytes. */
const D1_MAX_LIKE_BYTES = 50;

/** Wrap a sqlite database in the slice of the D1 API the Worker uses. */
export function d1From(db: SqliteDb): D1Database {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const rows = () => db.prepare(sql).all(...args).map((r) => ({ ...r }));
    const stmt = {
      bind(...params: unknown[]) {
        if (params.length > D1_MAX_BINDS) throw new Error("D1_ERROR: too many SQL variables");
        // D1 also rejects a LIKE/GLOB pattern over 50 bytes, where stock SQLite
        // allows 50,000. Without this a long pattern passes here and 500s live.
        if (/\b(LIKE|GLOB)\b/i.test(sql)) {
          for (const v of params) {
            if (typeof v === "string" && new TextEncoder().encode(v).length > D1_MAX_LIKE_BYTES) {
              throw new Error("D1_ERROR: LIKE or GLOB pattern too complex");
            }
          }
        }
        args = params;
        return stmt;
      },
      async run() {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
      async all() {
        return { results: rows() };
      },
      async first() {
        const r = db.prepare(sql).get(...args);
        return r ? { ...r } : null;
      },
      /** Synchronous execution, for batch(). */
      execSync: rows,
    };
    return stmt;
  };
  // D1 runs a batch as one transaction: all of it commits, or none of it.
  const batch = async (statements: { execSync: () => Record<string, unknown>[] }[]) => {
    db.exec("BEGIN");
    try {
      const out = statements.map((st) => ({ success: true, results: st.execSync() }));
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return { prepare, batch } as unknown as D1Database;
}

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
  /** Upload time; tests may overwrite it to age an object. */
  uploaded: Date;
}

function toBytes(value: unknown): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value as ArrayBuffer);
}

/** Map-backed R2. `objects` is exposed so tests can inspect what is left. */
export function r2From(objects: Map<string, StoredObject>) {
  return {
    async put(key: string, value: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: toBytes(value), contentType: opts?.httpMetadata?.contentType, uploaded: new Date() });
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      const text = () => new TextDecoder().decode(o.bytes);
      return {
        body: o.bytes,
        httpMetadata: { contentType: o.contentType },
        json: async () => JSON.parse(text()),
        text: async () => text(),
      };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    // Lexicographic and paginated, like R2: `cursor` is the offset of the next page.
    async list({ prefix, limit = 1000, cursor }: { prefix: string; limit?: number; cursor?: string }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const page = keys.slice(from, from + limit);
      const truncated = from + limit < keys.length;
      return {
        objects: page.map((key) => ({ key, uploaded: objects.get(key)!.uploaded })),
        truncated,
        cursor: truncated ? String(from + limit) : undefined,
      };
    },
  };
}

export interface SqliteEnv {
  env: Env;
  db: SqliteDb;
  objects: Map<string, StoredObject>;
  /** Messages handed to the send_email binding. */
  sent: Record<string, unknown>[];
}

export const TEST_TOKEN = "secret-token";

export async function makeSqliteEnv(overrides: Partial<Env> = {}): Promise<SqliteEnv> {
  const db = await openSqlite();
  db.exec(await readRepoFile("schema.sql"));
  const objects = new Map<string, StoredObject>();
  const sent: Record<string, unknown>[] = [];
  const env = {
    DB: d1From(db),
    MAILSTORE: r2From(objects),
    EMAIL: {
      async send(msg: Record<string, unknown>) {
        sent.push(msg);
        return { messageId: `<cf-${sent.length}@send.example.com>` };
      },
    },
    AI: { run: async () => ({ response: "primary" }) },
    INBOX_DOMAIN: "example.com",
    FROM_DOMAIN: "send.example.com",
    DEFAULT_FROM_LOCAL: "hello",
    ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    AUTH_TOKEN: TEST_TOKEN,
    ...overrides,
  } as unknown as Env;
  return { env, db, objects, sent };
}

/** Build a raw message from header pairs and a body (CRLF line endings). */
export function eml(headers: Record<string, string>, body = "hello body", contentType = "text/plain"): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return [...lines, `Content-Type: ${contentType}; charset=utf-8`, "", body, ""].join("\r\n");
}

export interface DeliverOptions {
  to?: string;
  forward?: (address: string) => Promise<void>;
}

/** Run the inbound handler to completion, including its waitUntil work. */
export async function deliver(env: Env, raw: string, opts: DeliverOptions = {}): Promise<void> {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext;
  const message = {
    from: "envelope@example.com",
    to: opts.to ?? "me@example.com",
    raw: new Response(raw).body,
    rawSize: raw.length,
    headers: new Headers(),
    setReject: () => {},
    forward: opts.forward ?? (async () => {}),
    reply: async () => {},
  } as unknown as ForwardableEmailMessage;
  try {
    await worker.email!(message, env, ctx);
  } finally {
    await Promise.allSettled(waits);
  }
}

/** Call the HTTP API as the full-access bearer principal. */
export async function api(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await handleFetch(
    new Request(`https://inbox.example.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
  const type = res.headers.get("content-type") || "";
  return {
    status: res.status,
    body: type.includes("json") ? await res.json() : await res.text(),
    headers: res.headers,
  };
}
