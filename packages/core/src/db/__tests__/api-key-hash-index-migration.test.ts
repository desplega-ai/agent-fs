import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("adds the API key hash index to old databases and uses it for auth lookup", () => {
  const db = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace(
      "CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash);\n\n",
      ""
    );
    expect(oldSql).not.toContain("idx_users_api_key_hash");
    db.exec(oldSql);
    db.exec("INSERT INTO users (id, email, api_key_hash, created_at) VALUES ('u', 'u@example.com', 'hash', 1)");

    runMigrations(db);
    runMigrations(db);

    const index = db.prepare("PRAGMA index_list(users)").all() as Array<{ name: string }>;
    expect(index.some(({ name }) => name === "idx_users_api_key_hash")).toBe(true);

    // This equality predicate matches getUserByApiKey's Drizzle query.
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id, email FROM users WHERE api_key_hash = ?").all("hash") as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("idx_users_api_key_hash"))).toBe(true);
  } finally {
    db.close();
  }
});
