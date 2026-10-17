import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runEmbeddingStatusMigration } from "../embedding-status-migration.js";
import { runMigrations } from "../migrate.js";

test("old databases accept skipped while preserving data, schema objects and foreign keys", () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(CREATE_TABLES_SQL.replace("'failed', 'skipped'", "'failed'"));
    db.exec("INSERT INTO orgs(id, name, created_at) VALUES ('org', 'org', 1)");
    db.exec("INSERT INTO drives(id, org_id, name, created_at) VALUES ('drive', 'org', 'drive', 1)");
    db.exec("ALTER TABLE files ADD COLUMN future_value TEXT DEFAULT 'preserved'");
    db.exec("CREATE INDEX custom_status_index ON files(embedding_status, future_value)");
    db.exec("CREATE TRIGGER custom_status_trigger AFTER UPDATE OF embedding_status ON files BEGIN UPDATE files SET future_value = 'triggered' WHERE path = new.path AND drive_id = new.drive_id; END");
    for (const status of ["pending", "indexed", "failed", null]) {
      db.prepare("INSERT INTO files(path, drive_id, size, author, created_at, modified_at, embedding_status, image_embedding_status) VALUES (?, 'drive', 1, 'author', 1, 1, ?, 'indexed')").run(`/${status}.md`, status);
    }
    const filesBefore = db.prepare("SELECT * FROM files ORDER BY path").all();
    const objectsBefore = db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'files' AND type IN ('index', 'trigger') ORDER BY name").all();
    expect(() => db.exec("UPDATE files SET embedding_status = 'skipped'")).toThrow();
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM files ORDER BY path").all()).toEqual(filesBefore);
    expect(() => db.exec("UPDATE files SET embedding_status = 'skipped'")).toThrow();
    runEmbeddingStatusMigration(db);
    runEmbeddingStatusMigration(db);
    expect(db.prepare("SELECT * FROM files ORDER BY path").all()).toEqual(filesBefore);
    expect(db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'files' AND type IN ('index', 'trigger') ORDER BY name").all()).toEqual(objectsBefore);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_list(files)").all()).toMatchObject([{ table: "drives", from: "drive_id", to: "id" }]);
    db.exec("UPDATE files SET embedding_status = 'skipped' WHERE path = '/indexed.md'");
    expect(db.prepare("SELECT embedding_status, image_embedding_status, future_value FROM files WHERE path = '/indexed.md'").get()).toEqual({
      embedding_status: "skipped", image_embedding_status: "indexed", future_value: "triggered",
    });
    db.exec("INSERT INTO files(path, drive_id, size, author, created_at, modified_at) VALUES ('/default.md', 'drive', 1, 'author', 1, 1)");
    expect(db.prepare("SELECT embedding_status FROM files WHERE path = '/default.md'").get()).toEqual({ embedding_status: "pending" });
    expect(() => db.exec("UPDATE files SET embedding_status = 'unknown'")).toThrow();
    expect(() => db.exec("UPDATE files SET image_embedding_status = 'skipped'")).toThrow();
    expect(() => db.exec("UPDATE files SET drive_id = 'unknown'")).toThrow();
    expect(db.prepare("PRAGMA table_info(files)").all().filter((row: any) => row.name === "embedding_status")).toHaveLength(1);
  } finally {
    db.close();
  }
});
