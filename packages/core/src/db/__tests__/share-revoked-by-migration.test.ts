import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("an existing DB without shares.revoked_by gets the column, and old revoked rows keep a null revoker", () => {
  const raw = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace("  revoked_at INTEGER,\n  revoked_by TEXT\n", "  revoked_at INTEGER\n");
    expect(oldSql).not.toContain("revoked_by");
    raw.exec(oldSql);
    raw
      .prepare(
        "INSERT INTO shares (id, org_id, drive_id, path, token_hash, expires_at, created_by, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run("old", "o", "d", "/a.md", "h", 4_102_444_800, "u", 1_700_000_000, 1_700_000_100);

    runMigrations(raw);
    runMigrations(raw);

    const col = (raw.prepare("PRAGMA table_info(shares)").all() as Array<{ name: string; notnull: number }>)
      .find((c) => c.name === "revoked_by");
    expect(col).toMatchObject({ notnull: 0 });
    expect(raw.prepare("SELECT revoked_at, revoked_by FROM shares WHERE id = 'old'").get()).toEqual({
      revoked_at: 1_700_000_100,
      revoked_by: null,
    });
  } finally {
    raw.close();
  }
});
