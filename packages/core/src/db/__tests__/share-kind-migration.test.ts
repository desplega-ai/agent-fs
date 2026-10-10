import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";
import { schema } from "../index.js";
import { findShareByToken, generateShareToken, hashShareToken } from "../../ops/share.js";

test("an existing DB without shares.kind gets the column, and old rows read as file", () => {
  const raw = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace("  kind TEXT NOT NULL DEFAULT 'file',\n", "");
    expect(oldSql).not.toContain("kind TEXT NOT NULL DEFAULT 'file'");
    raw.exec(oldSql);
    const token = generateShareToken();
    raw
      .prepare(
        "INSERT INTO shares (id, org_id, drive_id, path, token_hash, expires_at, max_views, views, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("old", "o", "d", "/a.md", hashShareToken(token), 4_102_444_800, null, 0, "u", 1_700_000_000);

    runMigrations(raw);
    runMigrations(raw);

    const col = (raw.prepare("PRAGMA table_info(shares)").all() as Array<{ name: string; notnull: number; dflt_value: string }>)
      .find((c) => c.name === "kind");
    expect(col).toMatchObject({ notnull: 1, dflt_value: "'file'" });
    const db = drizzle(raw, { schema }) as any;
    expect(findShareByToken(db, token)!.kind).toBe("file");
  } finally {
    raw.close();
  }
});
