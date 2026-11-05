import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { Webhook } from "standardwebhooks";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../../errors.js";
import { createUser } from "../../identity/users.js";
import { createDrive } from "../../identity/drives.js";
import { grantDriveRole, grantOrgRole } from "../../identity/grants.js";
import { listUserOrgs } from "../../identity/orgs.js";
import { listDrives } from "../../identity/drives.js";
import { dispatchOp } from "../index.js";
import type { OpContext } from "../types.js";
import { __resetEncryptionKeyForTests, getWebhookSecretKey } from "../../webhooks/crypto/key.js";
import { decryptSecret } from "../../webhooks/crypto/secrets-cipher.js";
import { MAX_SUBSCRIPTIONS_PER_ORG } from "../../webhooks/events.js";
import type { PublicWebhook } from "../../webhooks/subscriptions.js";

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

    for (const eventTypes of [["ping"], ["file.changed"], [], ["comment.created", "nope"]]) {
      await expect(op(ctx, "webhook-create", { url: URL_A, eventTypes })).rejects.toBeInstanceOf(ZodError);
    }
    await expect(op(ctx, "webhook-create", { url: "not a url", eventTypes: ["comment.created"] })).rejects.toBeInstanceOf(ZodError);
    await expect(op(ctx, "webhook-create", { url: URL_A, eventTypes: ["comment.created"], scope: "all" })).rejects.toBeInstanceOf(ZodError);
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
