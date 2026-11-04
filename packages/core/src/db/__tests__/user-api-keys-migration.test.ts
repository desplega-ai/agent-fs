import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL, USER_API_KEYS_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("an existing DB without user_api_keys gains the table and its indexes", () => {
  const raw = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace(USER_API_KEYS_SQL, "");
    expect(oldSql).not.toContain("user_api_keys");
    raw.exec(oldSql);
    const tables = () =>
      raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%user_api_keys%' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name").all();
    expect(tables()).toEqual([]);

    runMigrations(raw);
    runMigrations(raw);

    expect(tables()).toEqual([
      { name: "idx_user_api_keys_org" },
      { name: "idx_user_api_keys_user" },
      { name: "user_api_keys" },
      { name: "user_api_keys_key_hash_uq" },
    ]);
  } finally {
    raw.close();
  }
});

test("key_hash is unique", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec(USER_API_KEYS_SQL);
    const insert = raw.prepare(
      "INSERT INTO user_api_keys (id, user_id, key_hash, label, created_at, created_by_user_id) VALUES (?,?,?,?,?,?)"
    );
    insert.run("a", "u", "h1", "l", 1, "u");
    expect(() => insert.run("b", "u2", "h1", "l", 1, "u2")).toThrow();
  } finally {
    raw.close();
  }
});
