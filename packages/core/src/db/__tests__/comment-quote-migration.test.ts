import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("adds nullable quote columns to old comments tables, idempotently", () => {
  const db = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace("  quote_exact TEXT,\n  quote_prefix TEXT,\n  quote_suffix TEXT,\n", "");
    expect(oldSql).not.toContain("quote_exact");
    db.exec(oldSql);
    runMigrations(db);
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info(comments)").all() as Array<{ name: string; notnull: number }>)
      .filter((c) => c.name.startsWith("quote_"));
    expect(cols.map((c) => c.name).sort()).toEqual(["quote_exact", "quote_prefix", "quote_suffix"]);
    expect(cols.every((c) => c.notnull === 0)).toBe(true);
  } finally { db.close(); }
});
