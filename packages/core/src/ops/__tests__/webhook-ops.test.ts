import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Server } from "bun";
import { eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { EditConflictError, NotFoundError, PermissionDeniedError, ValidationError } from "../../errors.js";
import { createUser } from "../../identity/users.js";
import { createDrive } from "../../identity/drives.js";
import { grantDriveRole, grantOrgRole } from "../../identity/grants.js";
import { listUserOrgs } from "../../identity/orgs.js";
import { listDrives } from "../../identity/drives.js";
import { dispatchOp } from "../index.js";
import type { OpContext } from "../types.js";
import { __resetEncryptionKeyForTests, getWebhookSecretKey } from "../../webhooks/crypto/key.js";
import { decryptSecret } from "../../webhooks/crypto/secrets-cipher.js";
import {
  COMMENT_WEBHOOK_EVENT_TYPES,
  MAX_SUBSCRIPTIONS_PER_ORG,
  WEBHOOK_EVENT_TYPES,
} from "../../webhooks/events.js";
import type { PublicWebhook } from "../../webhooks/subscriptions.js";
import type { PublicDelivery } from "../../webhooks/deliveries.js";
import { runWebhookTickForTests } from "../../webhooks/worker.js";

// Fixed test key: in-memory DBs must never auto-generate one in a real home.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

interface Received {
  headers: Record<string, string>;
  body: string;
}

let server: Server<unknown>;
let receiverUrl: string;
const received: Received[] = [];
let receiverStatus = 200;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "AGENT_FS_SECRETS_KEY",
  "AGENT_FS_SECRETS_KEY_FILE",
  "AGENT_FS_WEBHOOK_ALLOWED_HOSTS",
  "AGENT_FS_WEBHOOK_ALLOW_PRIVATE",
  "AGENT_FS_WEBHOOK_WORKER",
];

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      received.push({ headers: Object.fromEntries(req.headers.entries()), body: await req.text() });
      return new Response("pong", { status: receiverStatus });
    },
  });
  receiverUrl = `http://127.0.0.1:${server.port}/hook`;
  process.env.AGENT_FS_SECRETS_KEY = TEST_KEY;
  delete process.env.AGENT_FS_SECRETS_KEY_FILE;
  delete process.env.AGENT_FS_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.AGENT_FS_WEBHOOK_WORKER;
  // hooks.test is allowlisted so creates never touch real DNS.
  process.env.AGENT_FS_WEBHOOK_ALLOWED_HOSTS = `hooks.test,127.0.0.1:${server.port}`;
  __resetEncryptionKeyForTests();
});

afterAll(() => {
  server.stop(true);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetEncryptionKeyForTests();
});

beforeEach(() => {
  received.length = 0;
  receiverStatus = 200;
});

const URL_A = "https://hooks.test/a";

/**
 * Owner (org admin, drive admin), plus members of the org's default drive:
 * viewer, editor, drive admin (org editor) and org admin (drive viewer).
 */
function fixture() {
  const base = createTestContext();
  const { db, ctx } = base;
  const member = (email: string, orgRole: "viewer" | "editor" | "admin", driveRole: "viewer" | "editor" | "admin") => {
    const { user } = createUser(db, { email });
    grantOrgRole(db, { orgId: ctx.orgId, userId: user.id, role: orgRole });
    grantDriveRole(db, { driveId: ctx.driveId, userId: user.id, role: driveRole });
    return user.id;
  };
  const viewer = member("viewer@example.com", "viewer", "viewer");
  const editor = member("editor@example.com", "editor", "editor");
  const driveAdmin = member("driveadmin@example.com", "editor", "admin");
  const orgAdmin = member("orgadmin@example.com", "admin", "viewer");
  const as = (userId: string, driveId = ctx.driveId): OpContext => ({ ...ctx, userId, driveId });
  return { ...base, viewer, editor, driveAdmin, orgAdmin, as };
}

type Created = PublicWebhook & { secret: string };

function op<T = any>(ctx: OpContext, name: string, params: unknown): Promise<NoInfer<T>> {
  return dispatchOp(ctx, name, params) as Promise<NoInfer<T>>;
}

function storedRow(db: DB, id: string) {
  return db.select().from(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.id, id)).get();
}

function addPendingDelivery(db: DB, subscriptionId: string): string {
  const id = crypto.randomUUID();
  const now = new Date();
  db.insert(schema.webhookDeliveries)
    .values({
      id,
      subscriptionId,
      eventId: crypto.randomUUID(),
      eventType: "comment.created",
      payload: "{}",
      nextAttemptAt: now,
      leaseUntil: now,
      createdAt: now,
    })
    .run();
  return id;
}

function deliveryRows(db: DB, subscriptionId?: string) {
  return db
    .select()
    .from(schema.webhookDeliveries)
    .where(subscriptionId ? eq(schema.webhookDeliveries.subscriptionId, subscriptionId) : undefined)
    .all();
}

describe("webhook ops", () => {
  test("webhook-list keeps creation order when hooks share a createdAt millisecond", async () => {
    const { ctx } = fixture();
    // Freeze the clock so every hook gets the same createdAt; ids are random UUIDs.
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        ids.push((await op<Created>(ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] })).id);
      }
      const { webhooks } = await op<{ webhooks: PublicWebhook[] }>(ctx, "webhook-list", {});
      expect(webhooks.map((w) => w.id)).toEqual(ids);
    } finally {
      setSystemTime();
    }
  });

  test("create, list, update, test and delete round-trip", async () => {
    const { ctx, db, driveId } = fixture();

    const created = await op<Created>(ctx, "webhook-create", {
      url: receiverUrl,
      eventTypes: ["comment.mentioned", "comment.created", "comment.mentioned"],
      description: "  agents  ",
    });
    expect(created).toMatchObject({
      scope: "drive",
      driveId,
      url: receiverUrl,
      description: "agents",
      eventTypes: ["comment.mentioned", "comment.created"],
      enabled: true,
      disabledReason: null,
      disabledAt: null,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      createdBy: ctx.userId,
      workerEnabled: false,
    });
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(typeof created.createdAt).toBe("string");

    const listed = await op<{ webhooks: PublicWebhook[] }>(ctx, "webhook-list", {});
    expect(listed.webhooks.map((w) => w.id)).toEqual([created.id]);
    expect(listed.webhooks[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(listed)).not.toContain(created.secret);

    const updated = await op<PublicWebhook>(ctx, "webhook-update", {
      id: created.id,
      eventTypes: ["comment.resolved"],
      description: "",
    });
    expect(updated).toMatchObject({ eventTypes: ["comment.resolved"], description: null });
    expect(updated).not.toHaveProperty("secret");

    const result = await op(ctx, "webhook-test", { id: created.id });
    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(result.webhookId).toMatch(/^ping_[0-9a-f-]{36}$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(received).toHaveLength(1);
    const ping = new Webhook(created.secret).verify(received[0].body, received[0].headers) as any;
    expect(ping.type).toBe("ping");
    expect(ping.data).toEqual({ subscriptionId: created.id, orgId: ctx.orgId, driveId });
    expect(new Date(ping.timestamp).toISOString()).toBe(ping.timestamp);
    expect(received[0].headers["webhook-id"]).toBe(result.webhookId);
    // A test ping writes no delivery row and touches no counter.
    expect(deliveryRows(db)).toHaveLength(0);
    expect(storedRow(db, created.id)).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null });

    addPendingDelivery(db, created.id);
    expect(await op(ctx, "webhook-delete", { id: created.id })).toEqual({ deleted: true });
    expect(storedRow(db, created.id)).toBeUndefined();
    expect(deliveryRows(db)).toHaveLength(0);
    expect((await op<{ webhooks: PublicWebhook[] }>(ctx, "webhook-list", {})).webhooks).toEqual([]);
    await expect(op(ctx, "webhook-test", { id: created.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the secret is returned only on create and rotate, and stored encrypted", async () => {
    const { ctx, db } = fixture();
    const created = await op<Created>(ctx, "webhook-create", { url: receiverUrl, eventTypes: ["comment.created"] });
    const row = storedRow(db, created.id)!;
    expect(row.secretCiphertext).not.toBe(created.secret);
    expect(row.secretCiphertext).not.toContain(created.secret.slice(6));
    expect(decryptSecret(row.secretCiphertext, getWebhookSecretKey(db))).toBe(created.secret);

    const rotated = await op<Created>(ctx, "webhook-update", { id: created.id, rotateSecret: true });
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(created.secret);
    expect(decryptSecret(storedRow(db, created.id)!.secretCiphertext, getWebhookSecretKey(db))).toBe(rotated.secret);

    // The ping is signed with the new secret only.
    expect((await op(ctx, "webhook-test", { id: created.id })).ok).toBe(true);
    const [req] = received;
    expect(() => new Webhook(rotated.secret).verify(req.body, req.headers)).not.toThrow();
    expect(() => new Webhook(created.secret).verify(req.body, req.headers)).toThrow();

    const list = await op<{ webhooks: PublicWebhook[] }>(ctx, "webhook-list", { scope: "drive" });
    expect(JSON.stringify(list)).not.toContain(rotated.secret);
  });

  test("disable fails pending deliveries; enable clears the disabled state", async () => {
    const { ctx, db } = fixture();
    const created = await op<Created>(ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const pending = addPendingDelivery(db, created.id);
    db.update(schema.webhookSubscriptions)
      .set({ consecutiveFailures: 3, failingSince: new Date() })
      .where(eq(schema.webhookSubscriptions.id, created.id))
      .run();

    const disabled = await op<PublicWebhook>(ctx, "webhook-update", { id: created.id, enabled: false });
    expect(disabled).toMatchObject({ enabled: false, disabledReason: "manual" });
    expect(disabled.disabledAt).not.toBeNull();
    const failed = deliveryRows(db, created.id).find((d) => d.id === pending)!;
    expect(failed).toMatchObject({ status: "failed", lastError: "subscription disabled", leaseUntil: null });

    // Disabling again keeps the original reason.
    db.update(schema.webhookSubscriptions)
      .set({ disabledReason: "gone" })
      .where(eq(schema.webhookSubscriptions.id, created.id))
      .run();
    expect((await op<PublicWebhook>(ctx, "webhook-update", { id: created.id, enabled: false })).disabledReason).toBe("gone");

    const enabled = await op<PublicWebhook>(ctx, "webhook-update", { id: created.id, enabled: true });
    expect(enabled).toMatchObject({ enabled: true, disabledReason: null, disabledAt: null, consecutiveFailures: 0 });
    expect(storedRow(db, created.id)!.failingSince).toBeNull();
  });

  test("webhook-test reports a failing receiver without counting it", async () => {
    const { ctx, db } = fixture();
    const created = await op<Created>(ctx, "webhook-create", { url: receiverUrl, eventTypes: ["comment.created"] });
    receiverStatus = 500;
    const result = await op(ctx, "webhook-test", { id: created.id });
    expect(result).toMatchObject({ ok: false, statusCode: 500, error: "HTTP 500: pong" });
    expect(storedRow(db, created.id)).toMatchObject({ consecutiveFailures: 0, lastFailureAt: null, enabled: true });
  });

  test("workerEnabled reflects AGENT_FS_WEBHOOK_WORKER", async () => {
    const { ctx } = fixture();
    await op(ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    process.env.AGENT_FS_WEBHOOK_WORKER = "true";
    try {
      const { webhooks } = await op<{ webhooks: PublicWebhook[] }>(ctx, "webhook-list", {});
      expect(webhooks[0].workerEnabled).toBe(true);
    } finally {
      delete process.env.AGENT_FS_WEBHOOK_WORKER;
    }
  });

  test("create refuses private targets and invalid input", async () => {
    const { ctx } = fixture();
    const err = await op(ctx, "webhook-create", {
      url: "http://169.254.169.254/x",
      eventTypes: ["comment.created"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.field).toBe("url");

    await expect(
      op(ctx, "webhook-create", { url: "https://10.0.0.5/x", eventTypes: ["comment.created"] })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      op(ctx, "webhook-update", {
        id: (await op<Created>(ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] })).id,
        url: "http://127.0.0.1:1/x",
      })
    ).rejects.toBeInstanceOf(ValidationError);

    for (const eventTypes of [["ping"], ["file.*"], [], ["comment.created", "nope"]]) {
      await expect(op(ctx, "webhook-create", { url: URL_A, eventTypes })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(op(ctx, "webhook-create", { url: "not a url", eventTypes: ["comment.created"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(op(ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "all" })).rejects.toBeInstanceOf(ValidationError);
  });

  test("eventTypes is required, so no hook gets file.changed unless it lists it", async () => {
    const { ctx } = fixture();
    await expect(op(ctx, "webhook-create", { url: URL_A })).rejects.toBeInstanceOf(ValidationError);
    const all = await op<Created>(ctx, "webhook-create", { url: URL_A, eventTypes: [...WEBHOOK_EVENT_TYPES] });
    expect(all.eventTypes).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect(all.eventTypes).toContain("file.changed");
    const comments = await op<Created>(ctx, "webhook-create", { url: URL_A, eventTypes: [...COMMENT_WEBHOOK_EVENT_TYPES] });
    expect(comments.eventTypes).not.toContain("file.changed");
    // An update that leaves eventTypes out keeps the stored set.
    const updated = await op<PublicWebhook>(ctx, "webhook-update", { id: comments.id, description: "x" });
    expect(updated.eventTypes).toEqual([...COMMENT_WEBHOOK_EVENT_TYPES]);
  });

  test("pathPrefix is stored as a normalized /dir/, cleared by '' or '/', and refuses dot segments", async () => {
    const { ctx, db } = fixture();
    const created = await op<Created>(ctx, "webhook-create", {
      url: URL_A,
      eventTypes: ["file.changed"],
      pathPrefix: " docs/specs ",
    });
    expect(created.pathPrefix).toBe("/docs/specs/");
    expect(storedRow(db, created.id)?.pathPrefix).toBe("/docs/specs/");
    expect((await op<{ webhooks: PublicWebhook[] }>(ctx, "webhook-list", {})).webhooks[0].pathPrefix).toBe("/docs/specs/");

    expect((await op<PublicWebhook>(ctx, "webhook-update", { id: created.id, pathPrefix: "/a/" })).pathPrefix).toBe("/a/");
    expect((await op<PublicWebhook>(ctx, "webhook-update", { id: created.id, description: "x" })).pathPrefix).toBe("/a/");
    expect((await op<PublicWebhook>(ctx, "webhook-update", { id: created.id, pathPrefix: "/" })).pathPrefix).toBeNull();
    await op(ctx, "webhook-update", { id: created.id, pathPrefix: "/a" });
    expect((await op<PublicWebhook>(ctx, "webhook-update", { id: created.id, pathPrefix: "" })).pathPrefix).toBeNull();

    const root = await op<Created>(ctx, "webhook-create", { url: URL_A, eventTypes: ["file.changed"], pathPrefix: "/" });
    expect(root.pathPrefix).toBeNull();
    const plain = await op<Created>(ctx, "webhook-create", { url: URL_A, eventTypes: ["file.changed"] });
    expect(plain.pathPrefix).toBeNull();

    for (const pathPrefix of ["/a/../b", "..", "/a/./", "a\\..\\b", "/a\u0000"]) {
      const err = await op(ctx, "webhook-create", { url: URL_A, eventTypes: ["file.changed"], pathPrefix }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.field).toBe("pathPrefix");
    }
    const err = await op(ctx, "webhook-update", { id: created.id, pathPrefix: "/x/../y" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
  });

  test(`caps webhooks at ${MAX_SUBSCRIPTIONS_PER_ORG} per org, drive and org scope combined`, async () => {
    const { ctx, as, driveAdmin } = fixture();
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_ORG; i++) {
      await op(i % 2 ? ctx : as(driveAdmin), "webhook-create", {
        url: `${URL_A}/${i}`,
        eventTypes: ["comment.created"],
        ...(i % 2 ? { scope: "org" } : {}),
      });
    }
    const err = await op(ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain(`limit is ${MAX_SUBSCRIPTIONS_PER_ORG}`);
  });
});

describe("webhook ops RBAC", () => {
  test.each(["viewer", "editor"] as const)("a drive %s is refused every op on both scopes", async (who) => {
    const f = fixture();
    const caller = f.as(f[who]);
    const driveHook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const orgHook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "org" });

    const calls: Array<[string, unknown]> = [
      ["webhook-create", { url: URL_A, eventTypes: ["comment.created"] }],
      ["webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "org" }],
      ["webhook-list", {}],
      ["webhook-list", { scope: "drive" }],
      ["webhook-list", { scope: "org" }],
    ];
    for (const id of [driveHook.id, orgHook.id]) {
      calls.push(
        ["webhook-update", { id, description: "x" }],
        ["webhook-update", { id, rotateSecret: true }],
        ["webhook-delete", { id }],
        ["webhook-test", { id }]
      );
    }
    for (const [name, params] of calls) {
      const err = await op(caller, name, params).catch((e) => e);
      expect(err, `${who} ${name} ${JSON.stringify(params)}`).toBeInstanceOf(PermissionDeniedError);
    }
    // Nothing changed and nothing was sent.
    expect(storedRow(f.db, driveHook.id)!.description).toBeNull();
    expect(storedRow(f.db, orgHook.id)).toBeDefined();
    expect(received).toHaveLength(0);
  });

  test("a drive admin who is not an org admin manages drive hooks only", async () => {
    const f = fixture();
    const caller = f.as(f.driveAdmin);
    const orgHook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "org" });

    const mine = await op<Created>(caller, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    expect(mine.scope).toBe("drive");
    await expect(
      op(caller, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "org" })
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(op(caller, "webhook-list", { scope: "org" })).rejects.toBeInstanceOf(PermissionDeniedError);
    for (const [name, params] of [
      ["webhook-update", { id: orgHook.id, enabled: false }],
      ["webhook-delete", { id: orgHook.id }],
      ["webhook-test", { id: orgHook.id }],
    ] as const) {
      await expect(op(caller, name, params)).rejects.toBeInstanceOf(PermissionDeniedError);
    }

    // "all" shows this drive's hooks only.
    const { webhooks } = await op<{ webhooks: PublicWebhook[] }>(caller, "webhook-list", {});
    expect(webhooks.map((w) => w.id)).toEqual([mine.id]);
    expect((await op<PublicWebhook>(caller, "webhook-update", { id: mine.id, description: "ok" })).description).toBe("ok");
    expect(await op(caller, "webhook-delete", { id: mine.id })).toEqual({ deleted: true });
  });

  test("an org admin (drive viewer) manages drive and org hooks", async () => {
    const f = fixture();
    const caller = f.as(f.orgAdmin);
    const ownersDriveHook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const orgHook = await op<Created>(caller, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "org" });
    expect(orgHook).toMatchObject({ scope: "org", driveId: null });
    const driveHook = await op<Created>(caller, "webhook-create", { url: receiverUrl, eventTypes: ["comment.created"] });

    const { webhooks } = await op<{ webhooks: PublicWebhook[] }>(caller, "webhook-list", {});
    expect(webhooks.map((w) => w.id)).toEqual([orgHook.id, ownersDriveHook.id, driveHook.id]);
    expect((await op<{ webhooks: PublicWebhook[] }>(caller, "webhook-list", { scope: "org" })).webhooks.map((w) => w.id)).toEqual([orgHook.id]);
    expect((await op<{ webhooks: PublicWebhook[] }>(caller, "webhook-list", { scope: "drive" })).webhooks.map((w) => w.id)).toEqual([ownersDriveHook.id, driveHook.id]);

    expect((await op<PublicWebhook>(caller, "webhook-update", { id: ownersDriveHook.id, enabled: false })).enabled).toBe(false);
    expect((await op(caller, "webhook-test", { id: driveHook.id })).ok).toBe(true);
    expect(await op(caller, "webhook-delete", { id: orgHook.id })).toEqual({ deleted: true });
  });

  test("a hook id from another drive or another org is NotFound", async () => {
    const f = fixture();
    const driveB = createDrive(f.db, { orgId: f.ctx.orgId, name: "second", creatorUserId: f.ctx.userId });
    const inB = await op<Created>(f.as(f.ctx.userId, driveB.id), "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });

    const other = createUser(f.db, { email: "other@example.com" }).user;
    const otherOrg = listUserOrgs(f.db, other.id)[0];
    const otherCtx: OpContext = { ...f.ctx, userId: other.id, orgId: otherOrg.id, driveId: listDrives(f.db, otherOrg.id)[0].id };
    const foreignDrive = await op<Created>(otherCtx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const foreignOrg = await op<Created>(otherCtx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "org" });

    for (const id of [inB.id, foreignDrive.id, foreignOrg.id, "no-such-id"]) {
      for (const [name, params] of [
        ["webhook-update", { id, enabled: false }],
        ["webhook-delete", { id }],
        ["webhook-test", { id }],
      ] as const) {
        await expect(op(f.ctx, name, params)).rejects.toBeInstanceOf(NotFoundError);
      }
    }
    // The drive-B hook is still reachable from drive B, and nothing was touched.
    expect((await op<{ webhooks: PublicWebhook[] }>(f.as(f.ctx.userId, driveB.id), "webhook-list", { scope: "drive" })).webhooks.map((w) => w.id)).toEqual([inB.id]);
    expect((await op<{ webhooks: PublicWebhook[] }>(f.ctx, "webhook-list", {})).webhooks).toEqual([]);
    for (const id of [inB.id, foreignDrive.id, foreignOrg.id]) expect(storedRow(f.db, id)!.enabled).toBe(true);
  });
});

type DeliveryPage = { deliveries: PublicDelivery[]; nextCursor: string | null };

/** A delivery row in a given state, created `ageMs` ago. */
function addDelivery(
  db: DB,
  subscriptionId: string,
  p: {
    status?: "pending" | "delivered" | "failed";
    attempts?: number;
    ageMs?: number;
    leaseUntil?: Date | null;
    payload?: string;
  } = {}
) {
  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const at = new Date(Date.now() - (p.ageMs ?? 0));
  const payload = p.payload ?? JSON.stringify({ type: "comment.created", timestamp: at.toISOString(), data: { eventId } });
  db.insert(schema.webhookDeliveries)
    .values({
      id,
      subscriptionId,
      eventId,
      eventType: "comment.created",
      payload,
      status: p.status ?? "pending",
      attempts: p.attempts ?? 0,
      nextAttemptAt: at,
      leaseUntil: p.leaseUntil ?? null,
      lastAttemptAt: p.attempts ? at : null,
      lastStatusCode: p.status === "failed" ? 500 : null,
      lastError: p.status === "failed" ? "HTTP 500" : null,
      createdAt: at,
    })
    .run();
  return { id, eventId, payload };
}

function deliveryRow(db: DB, id: string) {
  return db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, id)).get()!;
}

describe("webhook-deliveries", () => {
  test("omits the payload by default and includes it with includePayload, newest first", async () => {
    const f = fixture();
    const hook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const older = addDelivery(f.db, hook.id, { status: "delivered", attempts: 1, ageMs: 2_000 });
    const newer = addDelivery(f.db, hook.id, { status: "failed", attempts: 8, ageMs: 1_000 });

    const plain = await op<DeliveryPage>(f.ctx, "webhook-deliveries", { id: hook.id });
    expect(plain.deliveries.map((d) => d.id)).toEqual([newer.id, older.id]);
    expect(plain.nextCursor).toBeNull();
    for (const d of plain.deliveries) expect("payload" in d).toBe(false);
    expect(plain.deliveries[0]).toMatchObject({
      subscriptionId: hook.id,
      eventId: newer.eventId,
      eventType: "comment.created",
      status: "failed",
      attempts: 8,
      nextAttemptAt: null,
      lastStatusCode: 500,
      lastError: "HTTP 500",
    });

    const full = await op<DeliveryPage>(f.ctx, "webhook-deliveries", { id: hook.id, includePayload: true });
    expect(full.deliveries.map((d) => d.payload)).toEqual([newer.payload, older.payload]);
  });

  test("pages with nextCursor and filters by status", async () => {
    const f = fixture();
    const hook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const ids = [5, 4, 3, 2, 1].map((age) => addDelivery(f.db, hook.id, { status: age % 2 ? "failed" : "delivered", ageMs: age * 1_000 }).id);
    const newestFirst = [...ids].reverse();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res: DeliveryPage = await op<DeliveryPage>(f.ctx, "webhook-deliveries", { id: hook.id, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...res.deliveries.map((d) => d.id));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    expect(seen).toEqual(newestFirst);

    const failed = await op<DeliveryPage>(f.ctx, "webhook-deliveries", { id: hook.id, status: "failed" });
    expect(failed.deliveries.map((d) => d.status)).toEqual(["failed", "failed", "failed"]);

    await expect(op(f.ctx, "webhook-deliveries", { id: hook.id, cursor: "garbage" })).rejects.toBeInstanceOf(ValidationError);
    await expect(op(f.ctx, "webhook-deliveries", { id: hook.id, limit: 201 })).rejects.toBeInstanceOf(ValidationError);
  });

  test("a deleted hook's deliveries are gone; another hook's are not listed", async () => {
    const f = fixture();
    const a = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const b = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const inA = addDelivery(f.db, a.id);
    addDelivery(f.db, b.id);
    expect((await op<DeliveryPage>(f.ctx, "webhook-deliveries", { id: a.id })).deliveries.map((d) => d.id)).toEqual([inA.id]);
    await op(f.ctx, "webhook-delete", { id: a.id });
    await expect(op(f.ctx, "webhook-deliveries", { id: a.id })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("webhook-redeliver", () => {
  test("resets status, next_attempt_at and lease_until, keeps attempts, and the worker resends it", async () => {
    const f = fixture();
    const hook = await op<Created>(f.ctx, "webhook-create", { url: receiverUrl, eventTypes: ["comment.created"] });
    const failed = addDelivery(f.db, hook.id, { status: "failed", attempts: 8, ageMs: 3_600_000, leaseUntil: new Date(Date.now() - 3_000_000) });
    const delivered = addDelivery(f.db, hook.id, { status: "delivered", attempts: 1, ageMs: 60_000 });

    const before = Date.now();
    const out = await op<PublicDelivery>(f.ctx, "webhook-redeliver", { deliveryId: failed.id });
    expect(out).toMatchObject({ id: failed.id, status: "pending", attempts: 8 });
    const row = deliveryRow(f.db, failed.id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(8);
    expect(row.leaseUntil).toBeNull();
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    // History is kept until the next attempt overwrites it.
    expect(row.lastError).toBe("HTTP 500");

    expect((await op<PublicDelivery>(f.ctx, "webhook-redeliver", { deliveryId: delivered.id })).status).toBe("pending");

    const summary = await runWebhookTickForTests(f.db);
    expect(summary).toMatchObject({ claimed: 2, delivered: 2 });
    expect(received.map((r) => r.headers["webhook-id"]).sort()).toEqual([failed.eventId, delivered.eventId].sort());
    const resent = received.find((r) => r.headers["webhook-id"] === failed.eventId)!;
    expect(resent.body).toBe(failed.payload);
    expect(new Webhook(hook.secret).verify(resent.body, resent.headers)).toBeTruthy();
    expect(deliveryRow(f.db, failed.id)).toMatchObject({ status: "delivered", attempts: 9 });
  });

  test("is refused while the hook is disabled, and works once it is re-enabled", async () => {
    const f = fixture();
    const hook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const row = addDelivery(f.db, hook.id, { status: "failed", attempts: 3 });
    await op(f.ctx, "webhook-update", { id: hook.id, enabled: false });

    const err = await op(f.ctx, "webhook-redeliver", { deliveryId: row.id }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("disabled");
    expect(deliveryRow(f.db, row.id)).toMatchObject({ status: "failed", attempts: 3 });

    await op(f.ctx, "webhook-update", { id: hook.id, enabled: true });
    expect((await op<PublicDelivery>(f.ctx, "webhook-redeliver", { deliveryId: row.id })).status).toBe("pending");
  });

  test("is refused while the delivery is being sent", async () => {
    const f = fixture();
    const hook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const leaseUntil = new Date(Date.now() + 60_000);
    const inFlight = addDelivery(f.db, hook.id, { status: "pending", attempts: 1, leaseUntil });
    await expect(op(f.ctx, "webhook-redeliver", { deliveryId: inFlight.id })).rejects.toBeInstanceOf(EditConflictError);
    expect(deliveryRow(f.db, inFlight.id).leaseUntil?.getTime()).toBe(leaseUntil.getTime());
  });
});

describe("webhook delivery ops RBAC", () => {
  test.each(["viewer", "editor"] as const)("a drive %s gets the same denial as on the hook itself", async (who) => {
    const f = fixture();
    const caller = f.as(f[who]);
    for (const scope of ["drive", "org"] as const) {
      const hook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope });
      const row = addDelivery(f.db, hook.id, { status: "failed", attempts: 2 });
      const onHook = await op(caller, "webhook-update", { id: hook.id, description: "x" }).catch((e) => e);
      expect(onHook).toBeInstanceOf(PermissionDeniedError);
      for (const [name, params] of [
        ["webhook-deliveries", { id: hook.id }],
        ["webhook-deliveries", { id: hook.id, includePayload: true }],
        ["webhook-redeliver", { deliveryId: row.id }],
      ] as const) {
        const err = await op(caller, name, params).catch((e) => e);
        expect(err, `${who} ${name} on a ${scope} hook`).toBeInstanceOf(PermissionDeniedError);
        expect(err.toJSON()).toEqual(onHook.toJSON());
      }
      expect(deliveryRow(f.db, row.id)).toMatchObject({ status: "failed", attempts: 2 });
    }
  });

  test("a drive admin reads drive-hook deliveries but not org-hook ones; an org admin reads both", async () => {
    const f = fixture();
    const driveHook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const orgHook = await op<Created>(f.ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "org" });
    const inDrive = addDelivery(f.db, driveHook.id, { status: "failed" });
    const inOrg = addDelivery(f.db, orgHook.id, { status: "failed" });

    const driveAdmin = f.as(f.driveAdmin);
    expect((await op<DeliveryPage>(driveAdmin, "webhook-deliveries", { id: driveHook.id })).deliveries).toHaveLength(1);
    await expect(op(driveAdmin, "webhook-deliveries", { id: orgHook.id })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(op(driveAdmin, "webhook-redeliver", { deliveryId: inOrg.id })).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await op<PublicDelivery>(driveAdmin, "webhook-redeliver", { deliveryId: inDrive.id })).status).toBe("pending");

    const orgAdmin = f.as(f.orgAdmin);
    expect((await op<DeliveryPage>(orgAdmin, "webhook-deliveries", { id: orgHook.id })).deliveries).toHaveLength(1);
    expect((await op<PublicDelivery>(orgAdmin, "webhook-redeliver", { deliveryId: inOrg.id })).status).toBe("pending");
  });

  test("a delivery of a hook in another drive or org is NotFound", async () => {
    const f = fixture();
    const driveB = createDrive(f.db, { orgId: f.ctx.orgId, name: "second", creatorUserId: f.ctx.userId });
    const inB = await op<Created>(f.as(f.ctx.userId, driveB.id), "webhook-create", { url: URL_A, eventTypes: ["comment.created"] });
    const other = createUser(f.db, { email: "other@example.com" }).user;
    const otherOrg = listUserOrgs(f.db, other.id)[0];
    const otherCtx: OpContext = { ...f.ctx, userId: other.id, orgId: otherOrg.id, driveId: listDrives(f.db, otherOrg.id)[0].id };
    const foreign = await op<Created>(otherCtx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "org" });

    for (const hook of [inB, foreign]) {
      const row = addDelivery(f.db, hook.id, { status: "failed" });
      await expect(op(f.ctx, "webhook-deliveries", { id: hook.id })).rejects.toBeInstanceOf(NotFoundError);
      await expect(op(f.ctx, "webhook-redeliver", { deliveryId: row.id })).rejects.toBeInstanceOf(NotFoundError);
      expect(deliveryRow(f.db, row.id).status).toBe("failed");
    }
    await expect(op(f.ctx, "webhook-redeliver", { deliveryId: "no-such-id" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
