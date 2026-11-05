import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { createUser } from "../../identity/users.js";
import { createDrive } from "../../identity/drives.js";
import { listUserOrgs } from "../../identity/orgs.js";
import { listDrives } from "../../identity/drives.js";
import { write } from "../write.js";
import { edit } from "../edit.js";
import { append } from "../append.js";
import { rm } from "../rm.js";
import { mv } from "../mv.js";
import { cp } from "../cp.js";
import { revert } from "../revert.js";
import { createVersion } from "../versioning.js";
import {
  onWebhooksEnqueued,
  type FileChangedWebhookData,
  type WebhookEnvelope,
} from "../../webhooks/outbox.js";
import { COMMENT_WEBHOOK_EVENT_TYPES, WEBHOOK_EVENT_TYPES } from "../../webhooks/events.js";

// Subscriptions are inserted directly with a dummy ciphertext: the outbox
// never touches secrets, so no key material is needed here.

function rawOf(db: DB): Database {
  return (db as unknown as { $client: Database }).$client;
}

function addSub(
  db: DB,
  params: {
    orgId: string;
    driveId?: string | null;
    createdBy: string;
    eventTypes?: readonly string[] | string;
    pathPrefix?: string | null;
    enabled?: boolean;
  }
): string {
  const id = crypto.randomUUID();
  const now = new Date();
  db.insert(schema.webhookSubscriptions)
    .values({
      id,
      orgId: params.orgId,
      driveId: params.driveId ?? null,
      url: "https://hooks.example.com/af",
      eventTypes:
        typeof params.eventTypes === "string"
          ? params.eventTypes
          : JSON.stringify(params.eventTypes ?? ["file.changed"]),
      pathPrefix: params.pathPrefix ?? null,
      secretCiphertext: "dummy-ciphertext",
      enabled: params.enabled ?? true,
      createdBy: params.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

interface Delivery {
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: string;
  payload: string;
  envelope: WebhookEnvelope<FileChangedWebhookData>;
}

/** Deliveries in insertion order. */
function deliveries(db: DB, subscriptionId?: string): Delivery[] {
  const rows = rawOf(db)
    .query(
      "SELECT subscription_id, event_id, event_type, status, payload FROM webhook_deliveries" +
        (subscriptionId ? " WHERE subscription_id = ?" : "") +
        " ORDER BY rowid"
    )
    .all(...(subscriptionId ? [subscriptionId] : [])) as Array<{
    subscription_id: string;
    event_id: string;
    event_type: string;
    status: string;
    payload: string;
  }>;
  return rows.map((r) => ({
    subscriptionId: r.subscription_id,
    eventId: r.event_id,
    eventType: r.event_type,
    status: r.status,
    payload: r.payload,
    envelope: JSON.parse(r.payload),
  }));
}

const summary = (d: Delivery) => [d.envelope.data.path, d.envelope.data.version, d.envelope.data.operation];

describe("file.changed webhook outbox", () => {
  test("one delivery per version from write, edit, append, cp, mv, revert and rm; none on a no-change write", async () => {
    const { ctx, db } = createTestContext({ versioningEnabled: true });
    const hook = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });
    let notified = 0;
    const off = onWebhooksEnqueued(() => notified++);
    try {
      await write(ctx, { path: "/a.md", content: "first" });
      await edit(ctx, { path: "/a.md", old_string: "first", new_string: "second" });
      await append(ctx, { path: "/a.md", content: " tail" });
      await cp(ctx, { from: "/a.md", to: "/copy.md" });
      await mv(ctx, { from: "/copy.md", to: "/moved.md" });
      await revert(ctx, { path: "/a.md", version: 1 });
      // Same bytes as the head: the deduped path writes no version.
      const deduped = await write(ctx, { path: "/a.md", content: "first", expectedVersion: 4 });
      expect(deduped.deduped).toBe(true);
      await rm(ctx, { path: "/a.md" });
    } finally {
      off();
    }

    const expected = [
      ["/a.md", 1, "write"],
      ["/a.md", 2, "edit"],
      ["/a.md", 3, "append"],
      ["/copy.md", 1, "write"],
      ["/moved.md", 1, "write"],
      ["/copy.md", 2, "delete"],
      ["/a.md", 4, "revert"],
      ["/a.md", 5, "delete"],
    ];
    const got = deliveries(db, hook);
    expect(got.map(summary)).toEqual(expected);
    // Exactly the version rows that exist, no more and no fewer.
    const versions = db
      .select({ path: schema.fileVersions.path, version: schema.fileVersions.version, operation: schema.fileVersions.operation })
      .from(schema.fileVersions)
      .all()
      .map((v) => [v.path, v.version, v.operation]);
    expect(versions.sort()).toEqual([...expected].sort());
    expect(got.every((d) => d.eventType === "file.changed" && d.envelope.type === "file.changed" && d.status === "pending")).toBe(true);
    expect(new Set(got.map((d) => d.eventId)).size).toBe(expected.length);
    expect(notified).toBe(expected.length);
  });

  test("the delivery commits or rolls back with the version row", async () => {
    // Version write fails: no version, no delivery, no notify.
    {
      const { ctx, db } = createTestContext();
      addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId });
      rawOf(db).exec("CREATE TRIGGER fail_file_insert BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
      let notified = 0;
      const off = onWebhooksEnqueued(() => notified++);
      try {
        await expect(createVersion(ctx, { path: "/failed.md", operation: "write", s3VersionId: "v1" })).rejects.toThrow("test rollback");
      } finally {
        off();
      }
      expect(db.select().from(schema.fileVersions).all()).toEqual([]);
      expect(deliveries(db)).toEqual([]);
      expect(notified).toBe(0);
    }
    // Delivery insert fails: the version rolls back with it.
    {
      const { ctx, db } = createTestContext();
      addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId });
      rawOf(db).exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT, 'outbox down'); END");
      await expect(createVersion(ctx, { path: "/failed.md", operation: "write", s3VersionId: "v1" })).rejects.toThrow("outbox down");
      expect(db.select().from(schema.fileVersions).all()).toEqual([]);
      expect(db.select().from(schema.files).all()).toEqual([]);
    }
    // Both commit together.
    {
      const { ctx, db } = createTestContext();
      const hook = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId });
      const version = await createVersion(ctx, { path: "/ok.md", operation: "write", s3VersionId: "v1", size: 3, etag: "e1" });
      expect(db.select().from(schema.fileVersions).all()).toHaveLength(1);
      expect(deliveries(db, hook).map(summary)).toEqual([["/ok.md", version, "write"]]);
    }
  });

  test("pathPrefix includes /a/ children and excludes /ab, for absolute and relative stored paths", async () => {
    const { ctx, db } = createTestContext();
    const hook = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, pathPrefix: "/a/" });
    const deep = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, pathPrefix: "/a/b c/" });
    const all = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId });

    const paths = [
      "/a/x.md", "/a/b c/y.md", "a/rel.md", "a/b c/rel.md", // inside /a/
      "/ab", "/ab/x.md", "/a", "/a.md", "/a0/x.md", "/b/a/x.md", // outside
      "ab/rel.md", "a", "a.md", "b/a/rel.md",
    ];
    for (const path of paths) {
      await createVersion(ctx, { path, operation: "write", s3VersionId: "v" });
    }

    expect(deliveries(db, hook).map((d) => d.envelope.data.path)).toEqual([
      "/a/x.md", "/a/b c/y.md", "/a/rel.md", "/a/b c/rel.md",
    ]);
    expect(deliveries(db, deep).map((d) => d.envelope.data.path)).toEqual(["/a/b c/y.md", "/a/b c/rel.md"]);
    expect(deliveries(db, all)).toHaveLength(paths.length);
  });

  test("a drive hook never receives another drive's events; an org hook gets every drive of its org only", async () => {
    const { ctx, db } = createTestContext();
    const driveB = createDrive(db, { orgId: ctx.orgId, name: "second", creatorUserId: ctx.userId });
    const other = createUser(db, { email: "other@example.com" }).user;
    const otherOrg = listUserOrgs(db, other.id)[0].id;
    const otherDrive = listDrives(db, otherOrg)[0].id;

    const hookA = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });
    const hookB = addSub(db, { orgId: ctx.orgId, driveId: driveB.id, createdBy: ctx.userId });
    const orgHook = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId });
    const otherOrgHook = addSub(db, { orgId: otherOrg, createdBy: other.id });
    const otherDriveHook = addSub(db, { orgId: otherOrg, driveId: otherDrive, createdBy: other.id });
    const disabled = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, enabled: false });

    await write(ctx, { path: "/on-a.md", content: "a" });
    await write({ ...ctx, driveId: driveB.id }, { path: "/on-b.md", content: "b" });

    const paths = (id: string) => deliveries(db, id).map((d) => [d.envelope.data.driveId, d.envelope.data.path]);
    expect(paths(hookA)).toEqual([[ctx.driveId, "/on-a.md"]]);
    expect(paths(hookB)).toEqual([[driveB.id, "/on-b.md"]]);
    expect(paths(orgHook)).toEqual([[ctx.driveId, "/on-a.md"], [driveB.id, "/on-b.md"]]);
    expect(deliveries(db, otherOrgHook)).toEqual([]);
    expect(deliveries(db, otherDriveHook)).toEqual([]);
    expect(deliveries(db, disabled)).toEqual([]);
    // One version fans out to both hooks under one webhook-id.
    expect(deliveries(db, hookA)[0].eventId).toBe(deliveries(db, orgHook)[0].eventId);
  });

  test("a hook without file.changed gets nothing, including every comment type and a corrupt row", async () => {
    const { ctx, db } = createTestContext();
    const comments = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, eventTypes: COMMENT_WEBHOOK_EVENT_TYPES });
    const driveComments = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId, eventTypes: ["comment.created"] });
    const corrupt = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, eventTypes: "not json" });
    const objectTypes = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, eventTypes: '{"file.changed":true}' });
    let notified = 0;
    const off = onWebhooksEnqueued(() => notified++);
    try {
      await write(ctx, { path: "/x.md", content: "x" });
      await rm(ctx, { path: "/x.md" });
    } finally {
      off();
    }
    for (const id of [comments, driveComments, corrupt, objectTypes]) expect(deliveries(db, id)).toEqual([]);
    expect(notified).toBe(0);
    // The write itself went through.
    expect(db.select().from(schema.fileVersions).all()).toHaveLength(2);
    // Every type, file.changed included, does receive it.
    const everything = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, eventTypes: WEBHOOK_EVENT_TYPES });
    await write(ctx, { path: "/y.md", content: "y" });
    expect(deliveries(db, everything)).toHaveLength(1);
  });

  test("the payload is metadata only: path, version, operation, author, size, etag, never content", async () => {
    const { ctx, db } = createTestContext();
    db.update(schema.users).set({ displayName: "Tess" }).where(eq(schema.users.id, ctx.userId)).run();
    const hook = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId });
    const content = "TOP-SECRET-BODY-4d1f";
    const appCtx = { ...ctx, appUrl: "https://live.example.com" };
    const written = await write(appCtx, { path: "notes/plan.md", content });
    await append(appCtx, { path: "/notes/plan.md", content: " MORE-SECRET-77" });
    await rm(appCtx, { path: "/notes/plan.md" });

    const got = deliveries(db, hook);
    expect(got).toHaveLength(3);
    for (const d of got) {
      expect(d.payload).not.toContain("SECRET");
      expect(Object.keys(d.envelope).sort()).toEqual(["data", "timestamp", "type"]);
      expect(Object.keys(d.envelope.data).sort()).toEqual(
        ["author", "driveId", "etag", "eventId", "operation", "orgId", "path", "size", "url", "version"]
      );
      expect(d.envelope.data.eventId).toBe(d.eventId);
    }
    expect(got[0].envelope.data).toEqual({
      eventId: got[0].eventId,
      orgId: ctx.orgId,
      driveId: ctx.driveId,
      path: "/notes/plan.md",
      url: expect.stringContaining("https://live.example.com/"),
      version: written.version,
      operation: "write",
      author: { id: ctx.userId, email: "test@example.com", displayName: "Tess" },
      size: content.length,
      etag: expect.any(String),
    });
    expect(got[1].envelope.data).toMatchObject({ version: 2, operation: "append", size: content.length + 15 });
    expect(got[2].envelope.data).toMatchObject({ version: 3, operation: "delete", size: null, etag: null });
    expect(new Date(got[0].envelope.timestamp).toISOString()).toBe(got[0].envelope.timestamp);

    // No app URL configured: no url field.
    await write(ctx, { path: "/plain.md", content: "p" });
    expect(deliveries(db, hook)[3].envelope.data).not.toHaveProperty("url");
  });
});
