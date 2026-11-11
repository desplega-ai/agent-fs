import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { NotFoundError } from "../../errors.js";
import { subscribeDrive } from "../../events/bus.js";
import { write } from "../write.js";
import { rm } from "../rm.js";

// rm on a path with no live file must not invent history: no version row,
// no tombstone, no file.changed event or webhook delivery.

function count(db: DB, table: string): number {
  const raw = (db as unknown as { $client: Database }).$client;
  return (raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function subscribe(db: DB, ctx: { orgId: string; driveId: string; userId: string }) {
  const now = new Date();
  db.insert(schema.webhookSubscriptions)
    .values({
      id: crypto.randomUUID(),
      orgId: ctx.orgId,
      driveId: ctx.driveId,
      url: "https://hooks.example.com/af",
      eventTypes: JSON.stringify(["file.changed"]),
      pathPrefix: null,
      secretCiphertext: "dummy-ciphertext",
      enabled: true,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function snapshot(db: DB) {
  return {
    versions: count(db, "file_versions"),
    files: count(db, "files"),
    deliveries: count(db, "webhook_deliveries"),
  };
}

describe("rm on a missing path", () => {
  test("a path that never existed throws NOT_FOUND and writes nothing", async () => {
    const { ctx, db } = createTestContext({ versioningEnabled: true });
    subscribe(db, ctx);
    const events: string[] = [];
    const off = subscribeDrive(ctx.driveId, (e) => events.push(e.type));
    try {
      const before = snapshot(db);
      const err = await rm(ctx, { path: "/never.md" }).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.code).toBe("NOT_FOUND");
      expect(err.path).toBe("/never.md");
      expect(snapshot(db)).toEqual(before);
      expect(events).toEqual([]);
    } finally {
      off();
    }
  });

  test("a second rm of a deleted file throws NOT_FOUND and adds no tombstone", async () => {
    const { ctx, db } = createTestContext({ versioningEnabled: true });
    subscribe(db, ctx);
    await write(ctx, { path: "/a.md", content: "hi" });
    const first = await rm(ctx, { path: "/a.md" });
    expect(first).toEqual({ path: "/a.md", deleted: true });

    const before = snapshot(db);
    await expect(rm(ctx, { path: "/a.md" })).rejects.toBeInstanceOf(NotFoundError);
    expect(snapshot(db)).toEqual(before);
  });

  test("a folder path throws NOT_FOUND", async () => {
    const { ctx, db } = createTestContext();
    await write(ctx, { path: "/docs/a.md", content: "hi" });
    const before = snapshot(db);
    await expect(rm(ctx, { path: "/docs" })).rejects.toBeInstanceOf(NotFoundError);
    expect(snapshot(db)).toEqual(before);
  });
});
