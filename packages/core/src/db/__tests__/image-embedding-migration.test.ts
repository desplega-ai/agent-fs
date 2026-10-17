import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("existing text chunks and files gain image columns once without losing data", () => {
  const raw = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL
      .replace(/,\n  kind TEXT NOT NULL DEFAULT 'text'/, "")
      .replace(/^  image_embedding_status TEXT[^\n]*\n/m, "");
    raw.exec(oldSql);
    raw.prepare("INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count, page) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("/old.pdf", "drive", 0, "old text", 0, 2, 2);
    raw.prepare("INSERT INTO files(path, drive_id, size, author, created_at, modified_at, embedding_status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("/old.pdf", "drive", 8, "author", 1, 1, "indexed");
    expect((raw.prepare("PRAGMA table_info(content_chunks)").all() as { name: string }[]).some((column) => column.name === "kind")).toBe(false);
    expect((raw.prepare("PRAGMA table_info(files)").all() as { name: string }[]).some((column) => column.name === "image_embedding_status")).toBe(false);

    runMigrations(raw);
    runMigrations(raw);

    expect(raw.prepare("SELECT content, page, kind FROM content_chunks").get())
      .toEqual({ content: "old text", page: 2, kind: "text" });
    expect(raw.prepare("SELECT embedding_status, image_embedding_status FROM files").get())
      .toEqual({ embedding_status: "indexed", image_embedding_status: null });
    for (const [table, column] of [["files", "image_embedding_status"], ["content_chunks", "kind"]]) {
      expect((raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).filter((item) => item.name === column)).toHaveLength(1);
    }
  } finally {
    raw.close();
  }
});
