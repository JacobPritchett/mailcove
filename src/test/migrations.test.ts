// schema.sql (what a fresh `npm run schema` applies) and migrations/ (what
// `wrangler d1 migrations apply` replays) are two descriptions of one database.
// These pin them together, on a real SQLite engine.
import { describe, it, expect } from "vitest";
import { openSqlite, readRepoFile, listRepoDir, type SqliteDb } from "./sqlite_env";

/** FTS5 creates these behind the virtual table; they are not ours to compare. */
const isShadowTable = (name: string) => /^messages_fts_/.test(name);

interface Shape {
  tables: Record<string, string[]>;
  indexes: Record<string, string>;
}

/** Tables (columns as name/type/notnull/default/pk, order-independent) and indexes. */
function shapeOf(db: SqliteDb): Shape {
  const objects = db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tables: Shape["tables"] = {};
  const indexes: Shape["indexes"] = {};
  for (const o of objects) {
    if (isShadowTable(o.name) || isShadowTable(o.tbl_name)) continue;
    if (o.type === "table") {
      const cols = db.prepare(`PRAGMA table_info("${o.name}")`).all() as {
        name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
      }[];
      tables[o.name] = cols
        .map((c) => `${c.name}|${c.type}|${c.notnull}|${String(c.dflt_value)}|${c.pk}`)
        .sort();
    } else if (o.type === "index") {
      const cols = db.prepare(`PRAGMA index_xinfo("${o.name}")`).all() as {
        name: string | null; desc: number; key: number;
      }[];
      indexes[o.name] = `${o.tbl_name}(${cols.filter((c) => c.key).map((c) => `${c.name}${c.desc ? " DESC" : ""}`).join(",")})`;
    }
  }
  return { tables, indexes };
}

async function migrationFiles(): Promise<string[]> {
  return (await listRepoDir("migrations")).filter((f) => f.endsWith(".sql"));
}

describe("migrations", () => {
  it("apply in order to an EMPTY database and arrive at schema.sql", async () => {
    const migrated = await openSqlite();
    const files = await migrationFiles();
    expect(files[0]).toBe("0000-init.sql");
    for (const f of files) {
      try {
        migrated.exec(await readRepoFile(`migrations/${f}`));
      } catch (e) {
        throw new Error(`${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const fresh = await openSqlite();
    fresh.exec(await readRepoFile("schema.sql"));

    expect(shapeOf(migrated)).toEqual(shapeOf(fresh));
  });

  it("0000 is a strict no-op on a database that already has every table", async () => {
    const db = await openSqlite();
    db.exec(await readRepoFile("schema.sql"));
    db.exec(`INSERT INTO messages (id, thread_id, direction, folder, date) VALUES ('m1','t1','in','inbox',1)`);
    const dump = () =>
      JSON.stringify({
        master: db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all(),
        rows: db.prepare(`SELECT * FROM messages`).all(),
      });
    const before = dump();
    db.exec(await readRepoFile("migrations/0000-init.sql"));
    expect(dump()).toBe(before);
  });

  it("0000 only ever creates-if-missing", async () => {
    const sql = (await readRepoFile("migrations/0000-init.sql"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
    }
  });

  it("indexes the columns the hot lookups filter on", async () => {
    const db = await openSqlite();
    db.exec(await readRepoFile("schema.sql"));
    const { indexes } = shapeOf(db);
    expect(Object.values(indexes)).toContain("messages(message_id)");
    // The inbound thread lookup must be an index search, not a table scan.
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT thread_id FROM messages WHERE message_id IN (?,?) ORDER BY date ASC LIMIT 1`)
      .all("<a@x>", "<b@x>") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING INDEX idx_messages_message_id/);
  });
});
