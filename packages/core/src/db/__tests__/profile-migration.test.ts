import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("adds nullable names to old databases and preserves them on restart", () => {
  const db = new Database(":memory:");
  try {
    db.exec(CREATE_TABLES_SQL.replace("  display_name TEXT,\n", ""));
    db.exec("INSERT INTO users (id,email,api_key_hash,created_at) VALUES ('u','u@example.com','hash',1)");
    runMigrations(db);
    expect(db.query("SELECT display_name FROM users").get()).toEqual({ display_name: null });
    db.exec("UPDATE users SET display_name = 'Name'");
    runMigrations(db);
    expect(db.query("SELECT display_name, email FROM users").get()).toEqual({ display_name: "Name", email: "u@example.com" });
  } finally { db.close(); }
});
