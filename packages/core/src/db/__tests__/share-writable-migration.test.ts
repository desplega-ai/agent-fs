import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";
import { schema } from "../index.js";
import { findShareByToken, generateShareToken, hashShareToken } from "../../ops/share.js";

test("an existing DB without the writable columns gets them, and old rows read as read-only", () => {
  const raw = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace(
      "  revoked_at INTEGER,\n  writable INTEGER NOT NULL DEFAULT 0,\n  guest_secret TEXT\n",
      "  revoked_at INTEGER\n"
    );
    expect(oldSql).not.toContain("guest_secret");
    raw.exec(oldSql);
    const token = generateShareToken();
    raw
      .prepare(
        "INSERT INTO shares (id, org_id, drive_id, path, kind, token_hash, expires_at, views, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("old", "o", "d", "/site", "site", hashShareToken(token), 4_102_444_800, 0, "u", 1_700_000_000);

    runMigrations(raw);
    runMigrations(raw);

    const cols = raw.prepare("PRAGMA table_info(shares)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    expect(cols.find((c) => c.name === "writable")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(cols.find((c) => c.name === "guest_secret")).toMatchObject({ notnull: 0, dflt_value: null });
    const db = drizzle(raw, { schema }) as any;
    expect(findShareByToken(db, token)).toMatchObject({ writable: false, guestSecret: null });
  } finally {
    raw.close();
  }
});
