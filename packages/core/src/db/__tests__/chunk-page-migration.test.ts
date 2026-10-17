import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("existing chunks receive a nullable page column once", () => {
  const raw = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace("  token_count INTEGER NOT NULL,\n  page INTEGER", "  token_count INTEGER NOT NULL");
    raw.exec(oldSql);
    expect((raw.prepare("PRAGMA table_info(content_chunks)").all() as { name: string }[])
      .some((c) => c.name === "page")).toBe(false);
    raw.prepare(
      "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("/old.txt", "drive", 0, "old text", 0, 2);

    runMigrations(raw);
    runMigrations(raw);

    expect(raw.prepare("SELECT content, page FROM content_chunks").get()).toEqual({ content: "old text", page: null });
    expect((raw.prepare("PRAGMA table_info(content_chunks)").all() as { name: string }[]).filter((c) => c.name === "page")).toHaveLength(1);
  } finally {
    raw.close();
  }
});
