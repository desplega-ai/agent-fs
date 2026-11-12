import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CREATE_TABLES_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("an existing DB without orgs.owner_user_id gets it, backfilled from each personal org's first member", () => {
  const raw = new Database(":memory:");
  try {
    const oldSql = CREATE_TABLES_SQL.replace("  swarm_url TEXT,\n  owner_user_id TEXT\n", "  swarm_url TEXT\n");
    expect(oldSql).not.toContain("owner_user_id");
    raw.exec(oldSql);
    const user = raw.prepare("INSERT INTO users (id, email, api_key_hash, created_at) VALUES (?, ?, 'h', 1)");
    user.run("ua", "a@example.test");
    user.run("ub", "b@example.test");
    const org = raw.prepare("INSERT INTO orgs (id, name, is_personal, created_at) VALUES (?, ?, ?, 1)");
    // A sorts after B by id, so only membership order can pick the owner.
    org.run("z-a", "a", 1);
    org.run("a-b", "b", 1);
    org.run("shared", "team", 0);
    const member = raw.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)");
    member.run("z-a", "ua", "admin");
    member.run("a-b", "ub", "admin");
    member.run("shared", "ua", "admin");
    // B is later added to A's personal org.
    member.run("z-a", "ub", "editor");

    runMigrations(raw);
    runMigrations(raw);

    expect(raw.prepare("SELECT id, owner_user_id FROM orgs ORDER BY id").all()).toEqual([
      { id: "a-b", owner_user_id: "ub" },
      { id: "shared", owner_user_id: null },
      { id: "z-a", owner_user_id: "ua" },
    ]);
  } finally {
    raw.close();
  }
});
