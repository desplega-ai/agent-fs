import "../setup-sqlite.js";

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrate.js";
import { CREATE_TABLES_SQL } from "../raw.js";

const MENTION_SCHEMA = `CREATE TABLE IF NOT EXISTS comment_mentions (
  comment_id TEXT NOT NULL REFERENCES comments(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_mentions_user ON comment_mentions(user_id);

`;

test("adds comment mentions storage to old databases without changing rows", () => {
  const db = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace(MENTION_SCHEMA, "");
    expect(oldSql).not.toContain("comment_mentions");
    db.exec(oldSql);
    db.exec(`
      INSERT INTO users (id, email, api_key_hash, created_at)
      VALUES ('u', 'u@example.com', 'hash', 1);
      INSERT INTO orgs (id, name, created_at) VALUES ('o', 'Org', 1);
      INSERT INTO drives (id, org_id, name, created_at) VALUES ('d', 'o', 'Drive', 1);
      INSERT INTO comments (
        id, org_id, drive_id, path, body, author, created_at, updated_at
      ) VALUES ('c', 'o', 'd', '/old.md', 'Old comment', 'u', 1, 1);
    `);

    db.exec(CREATE_TABLES_SQL);
    runMigrations(db);
    db.exec(CREATE_TABLES_SQL);
    runMigrations(db);

    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'comment_mentions'").get()
    ).toEqual({ name: "comment_mentions" });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_comment_mentions_user'").get()
    ).toEqual({ name: "idx_comment_mentions_user" });
    expect(db.query("SELECT id, body FROM comments").all()).toEqual([
      { id: "c", body: "Old comment" },
    ]);
  } finally {
    db.close();
  }
});
