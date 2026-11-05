import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CREATE_TABLES_SQL, WEBHOOKS_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";
import { createDatabase } from "../index.js";
import { createTestContext } from "../../test-utils.js";

const WEBHOOK_OBJECTS_SQL =
  "SELECT type, name FROM sqlite_master WHERE (name LIKE '%webhook%') AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name";

const EXPECTED_OBJECTS = [
  { type: "index", name: "idx_webhook_deliveries_due" },
  { type: "index", name: "idx_webhook_deliveries_sub" },
  { type: "index", name: "idx_webhook_subs_drive" },
  { type: "index", name: "idx_webhook_subs_org" },
  { type: "table", name: "webhook_deliveries" },
  { type: "table", name: "webhook_subscriptions" },
];

function oldSchemaSql(): string {
  const oldSql = CREATE_TABLES_SQL.replace(WEBHOOKS_SQL, "");
  expect(oldSql).not.toContain("webhook");
  return oldSql;
}

test("an existing DB without the webhook tables gains them, and a re-run is a no-op", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec(oldSchemaSql());
    const objects = () => raw.prepare(WEBHOOK_OBJECTS_SQL).all();
    expect(objects()).toEqual([]);

    runMigrations(raw);
    expect(objects()).toEqual(EXPECTED_OBJECTS);
    runMigrations(raw);
    expect(objects()).toEqual(EXPECTED_OBJECTS);
  } finally {
    raw.close();
  }
});

test("createDatabase on a pre-webhooks DB file adds both tables and the partial due index", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-fs-webhooks-migration-"));
  const dbPath = join(dir, "agent-fs.db");
  try {
    const old = new Database(dbPath);
    old.exec(oldSchemaSql());
    old.close();

    const db = createDatabase(dbPath);
    db.$client.close();

    const check = new Database(dbPath, { readonly: true });
    try {
      expect(check.prepare(WEBHOOK_OBJECTS_SQL).all()).toEqual(EXPECTED_OBJECTS);
      const due = check
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_webhook_deliveries_due'")
        .get() as { sql: string };
      expect(due.sql).toContain("WHERE status = 'pending'");
      const deliveries = check
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'webhook_deliveries'")
        .get() as { sql: string };
      expect(deliveries.sql).toContain("ON DELETE CASCADE");
      expect(deliveries.sql).toContain("UNIQUE(subscription_id, event_id)");
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a subscription cascades its deliveries; one delivery per (subscription, event)", () => {
  const { db, userId, orgId, driveId } = createTestContext();
  const raw = db.$client;
  const now = Date.now();
  const insertSub = raw.prepare(
    "INSERT INTO webhook_subscriptions (id, org_id, drive_id, url, event_types, secret_ciphertext, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  );
  const insertDelivery = raw.prepare(
    "INSERT INTO webhook_deliveries (id, subscription_id, event_id, event_type, payload, next_attempt_at, created_at) VALUES (?,?,?,?,?,?,?)"
  );
  insertSub.run("s1", orgId, driveId, "https://hooks.example.com/a", '["comment.created"]', "ct", userId, now, now);
  insertSub.run("s2", orgId, null, "https://hooks.example.com/b", '["comment.created"]', "ct", userId, now, now);
  insertDelivery.run("d1", "s1", "e1", "comment.created", "{}", now, now);
  insertDelivery.run("d2", "s1", "e2", "comment.created", "{}", now, now);
  // Same event to another hook is fine (same webhook-id fans out)...
  insertDelivery.run("d3", "s2", "e1", "comment.created", "{}", now, now);
  // ...but the same event twice to one hook is not.
  expect(() => insertDelivery.run("d4", "s1", "e1", "comment.created", "{}", now, now)).toThrow();

  const defaults = raw
    .prepare("SELECT status, attempts FROM webhook_deliveries WHERE id = 'd1'")
    .get();
  expect(defaults).toEqual({ status: "pending", attempts: 0 });

  raw.prepare("DELETE FROM webhook_subscriptions WHERE id = 's1'").run();

  const left = raw.prepare("SELECT id FROM webhook_deliveries ORDER BY id").all();
  expect(left).toEqual([{ id: "d3" }]);
});

test("status and disabled_reason are constrained", () => {
  const { db, userId, orgId } = createTestContext();
  const raw = db.$client;
  const now = Date.now();
  expect(() =>
    raw
      .prepare(
        "INSERT INTO webhook_subscriptions (id, org_id, url, event_types, secret_ciphertext, disabled_reason, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run("s1", orgId, "https://x.example", "[]", "ct", "bogus", userId, now, now)
  ).toThrow();
  raw
    .prepare(
      "INSERT INTO webhook_subscriptions (id, org_id, url, event_types, secret_ciphertext, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    .run("s2", orgId, "https://x.example", "[]", "ct", userId, now, now);
  expect(() =>
    raw
      .prepare(
        "INSERT INTO webhook_deliveries (id, subscription_id, event_id, event_type, payload, status, next_attempt_at, created_at) VALUES (?,?,?,?,?,?,?,?)"
      )
      .run("d1", "s2", "e1", "comment.created", "{}", "sent", now, now)
  ).toThrow();
});
