import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL, ORG_INVITES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("an existing DB without org_invites gains the table and its indexes", () => {
  const raw = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace(ORG_INVITES_SQL, "");
    expect(oldSql).not.toContain("org_invites");
    raw.exec(oldSql);
    const tables = () =>
      raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'org_invites%' ORDER BY name").all();
    expect(tables()).toEqual([]);

    runMigrations(raw);
    runMigrations(raw);

    expect(tables()).toEqual([
      { name: "org_invites" },
      { name: "org_invites_open_email_uq" },
      { name: "org_invites_token_hash_uq" },
    ]);
  } finally {
    raw.close();
  }
});

test("only one open invite per org and email", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec(ORG_INVITES_SQL);
    const insert = raw.prepare(
      "INSERT INTO org_invites (id, org_id, email, org_role, drives, token_hash, created_by, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    );
    insert.run("a", "o", "x@example.com", "viewer", "[]", "h1", "u", 1, 2, 1);
    insert.run("b", "o", "x@example.com", "viewer", "[]", "h2", "u", 1, 2, null);
    expect(() => insert.run("c", "o", "x@example.com", "viewer", "[]", "h3", "u", 1, 2, null)).toThrow();
  } finally {
    raw.close();
  }
});
