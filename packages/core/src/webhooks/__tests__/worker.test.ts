import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { createUser } from "../../identity/users.js";
import { grantDriveRole, grantOrgRole } from "../../identity/grants.js";
import { commentAdd } from "../../ops/comment.js";
import { __resetEncryptionKeyForTests, getWebhookSecretKey } from "../crypto/key.js";
import { encryptSecret } from "../crypto/secrets-cipher.js";
import { AUTO_DISABLE_AFTER_MS, LEASE_MS, RETRY_SCHEDULE_MS, WEBHOOK_EVENT_TYPES } from "../events.js";
import { notifyWebhooksEnqueued } from "../outbox.js";
import { generateWebhookSecret } from "../signature.js";
import {
  claimDueDeliveries,
  countEnabledWebhookSubscriptions,
  runWebhookTickForTests,
  SERVER_ERROR_RETRY_MS,
  startWebhookWorker,
  stopWebhookWorker,
  webhookRetryJitter,
} from "../worker.js";

// Fixed test key: in-memory DBs must never auto-generate one in a real home.
const TEST_KEY = Buffer.alloc(32, 9).toString("base64");
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["AGENT_FS_SECRETS_KEY", "AGENT_FS_SECRETS_KEY_FILE", "AGENT_FS_WEBHOOK_ALLOWED_HOSTS"];

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.AGENT_FS_SECRETS_KEY = TEST_KEY;
  delete process.env.AGENT_FS_SECRETS_KEY_FILE;
  delete process.env.AGENT_FS_WEBHOOK_ALLOWED_HOSTS;
  __resetEncryptionKeyForTests();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetEncryptionKeyForTests();
});

afterEach(async () => {
  await stopWebhookWorker();
});

// --- Fixtures ----------------------------------------------------------------

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A fake fetch answering from a queue of statuses (then `fallback`). Records
 * each request. Honours the abort signal like real fetch.
 */
function fakeFetch(statuses: number[] = [], fallback = 200) {
  const sent: Sent[] = [];
  const queue = [...statuses];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body),
    });
    const status = queue.shift() ?? fallback;
    return new Response(status === 204 ? null : `status ${status}`, { status });
  }) as typeof fetch;
  return { impl, sent };
}

/** A fetch that records the request, then waits for `release()` or an abort. */
function hangingFetch(opts: { honourAbort: boolean }) {
  const sent: Sent[] = [];
  let release: (status: number) => void = () => {};
  let started: () => void = () => {};
  const firstRequest = new Promise<void>((r) => (started = r));
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body),
    });
    started();
    return new Promise<Response>((resolve, reject) => {
      release = (status) => resolve(new Response("late", { status }));
      if (opts.honourAbort) {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        });
      }
    });
  }) as typeof fetch;
  return { impl, sent, firstRequest, release: (status = 200) => release(status) };
}

function setup() {
  const { db, ctx } = createTestContext();
  const secret = generateWebhookSecret();
  const subId = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId, secret });
  return { db, ctx, secret, subId };
}

function addSub(
  db: DB,
  p: { orgId: string; driveId?: string | null; createdBy: string; secret: string; enabled?: boolean }
): string {
  const id = crypto.randomUUID();
  const now = new Date();
  db.insert(schema.webhookSubscriptions)
    .values({
      id,
      orgId: p.orgId,
      driveId: p.driveId ?? null,
      url: `https://hooks.example.com/${id}`,
      eventTypes: JSON.stringify(WEBHOOK_EVENT_TYPES),
      secretCiphertext: encryptSecret(p.secret, getWebhookSecretKey(db)),
      enabled: p.enabled ?? true,
      createdBy: p.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function addDelivery(db: DB, subscriptionId: string, p: { at: number; eventId?: string }) {
  const id = crypto.randomUUID();
  const eventId = p.eventId ?? crypto.randomUUID();
  const payload = JSON.stringify({ type: "comment.created", timestamp: new Date(p.at).toISOString(), data: { eventId } });
  db.insert(schema.webhookDeliveries)
    .values({
      id,
      subscriptionId,
      eventId,
      eventType: "comment.created",
      payload,
      nextAttemptAt: new Date(p.at),
      createdAt: new Date(p.at),
    })
    .run();
  return { id, eventId, payload };
}

function delivery(db: DB, id: string) {
  return db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, id)).get()!;
}

function sub(db: DB, id: string) {
  return db.select().from(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.id, id)).get()!;
}

/** A mutable clock starting at real time, so standardwebhooks' tolerance holds. */
function clock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => (t = v),
    advance: (ms: number) => (t += ms),
    get value() {
      return t;
    },
  };
}

const mid = () => 0.5; // jitter factor exactly 1.0

// --- Tests -------------------------------------------------------------------

describe("webhookRetryJitter", () => {
  test("stays within ±20%", () => {
    expect(webhookRetryJitter(5_000, () => 0)).toBe(4_000);
    expect(webhookRetryJitter(5_000, () => 0.5)).toBe(5_000);
    expect(webhookRetryJitter(5_000, () => 0.999_999)).toBe(6_000);
  });
});

describe("webhook delivery worker", () => {
  test("a 2xx delivers a signed request and resets the subscription counters", async () => {
    const { db, secret, subId } = setup();
    const c = clock();
    db.update(schema.webhookSubscriptions)
      .set({ consecutiveFailures: 3, failingSince: new Date(c.value - 60_000) })
      .where(eq(schema.webhookSubscriptions.id, subId))
      .run();
    const d = addDelivery(db, subId, { at: c.value });
    const f = fakeFetch([204]);

    const summary = await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: mid });
    expect(summary).toMatchObject({ claimed: 1, delivered: 1, retrying: 0, failed: 0 });

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].url).toBe(`https://hooks.example.com/${subId}`);
    expect(f.sent[0].body).toBe(d.payload);
    expect(f.sent[0].headers["webhook-id"]).toBe(d.eventId);
    expect(new Webhook(secret).verify(f.sent[0].body, f.sent[0].headers)).toEqual(JSON.parse(d.payload));

    const row = delivery(db, d.id);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(row.deliveredAt?.getTime()).toBe(c.value);
    expect(row.lastStatusCode).toBe(204);
    expect(row.leaseUntil).toBeNull();
    expect(row.lastError).toBeNull();
    const s = sub(db, subId);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.failingSince).toBeNull();
    expect(s.lastSuccessAt?.getTime()).toBe(c.value);

    // Nothing left to do.
    expect((await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now })).claimed).toBe(0);
  });

  test("a 500 retries at schedule[0] ±20% with the same webhook-id", async () => {
    const { db, secret, subId } = setup();
    const c = clock();
    const d = addDelivery(db, subId, { at: c.value });
    const f = fakeFetch([500, 200]);

    const first = await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: () => 0 });
    expect(first).toMatchObject({ claimed: 1, retrying: 1 });
    let row = delivery(db, d.id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBe(c.value + RETRY_SCHEDULE_MS[0] * 0.8);
    expect(row.leaseUntil).toBeNull();
    expect(row.lastStatusCode).toBe(500);
    expect(row.lastError).toBe("HTTP 500: status 500");
    let s = sub(db, subId);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.failingSince?.getTime()).toBe(c.value);
    expect(s.lastFailureAt?.getTime()).toBe(c.value);

    // Not due yet.
    c.advance(RETRY_SCHEDULE_MS[0] * 0.8 - 1);
    expect((await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now })).claimed).toBe(0);

    c.advance(1);
    const second = await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: mid });
    expect(second).toMatchObject({ claimed: 1, delivered: 1 });
    expect(f.sent.map((r) => r.headers["webhook-id"])).toEqual([d.eventId, d.eventId]);
    expect(f.sent[0].body).toBe(f.sent[1].body);
    expect(new Webhook(secret).verify(f.sent[1].body, f.sent[1].headers)).toBeTruthy();
    row = delivery(db, d.id);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(2);
    s = sub(db, subId);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.failingSince).toBeNull();
  });

  test("the upper jitter bound is +20%", async () => {
    const { db, subId } = setup();
    const c = clock();
    const d = addDelivery(db, subId, { at: c.value });
    await runWebhookTickForTests(db, { fetchImpl: fakeFetch([], 503).impl, now: c.now, random: () => 0.999_999 });
    expect(delivery(db, d.id).nextAttemptAt.getTime()).toBe(c.value + RETRY_SCHEDULE_MS[0] * 1.2);
  });

  test("an undecryptable secret postpones the row without using an attempt or failing the hook", async () => {
    // Regression: a lost key file used to count as a receiver failure, so
    // retries ran out and the 5-day rule disabled every hook.
    const { db, ctx } = setup();
    const c = clock();
    const brokenSub = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, secret: generateWebhookSecret() });
    db.update(schema.webhookSubscriptions)
      .set({ secretCiphertext: "not-a-ciphertext" })
      .where(eq(schema.webhookSubscriptions.id, brokenSub))
      .run();
    const broken = addDelivery(db, brokenSub, { at: c.value });
    const f = fakeFetch();
    const env = { ...process.env, AGENT_FS_WEBHOOK_AUTO_DISABLE_MS: "1" };
    for (let i = 0; i < 12; i++) {
      const summary = await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: mid, env });
      expect(summary).toMatchObject({ claimed: 1, deferred: 1, retrying: 0, failed: 0 });
      expect(delivery(db, broken.id).nextAttemptAt.getTime()).toBe(c.value + SERVER_ERROR_RETRY_MS);
      c.advance(SERVER_ERROR_RETRY_MS);
    }
    expect(f.sent).toHaveLength(0);
    expect(delivery(db, broken.id)).toMatchObject({ status: "pending", attempts: 0, leaseUntil: null });
    expect(delivery(db, broken.id).lastError).toContain("cannot decrypt the signing secret");
    const sub = db
      .select()
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, brokenSub))
      .get();
    expect(sub).toMatchObject({ enabled: true, consecutiveFailures: 0, failingSince: null, disabledReason: null });
  });

  test("a 3xx and a network error are retried failures", async () => {
    const { db, ctx, subId } = setup();
    const c = clock();
    const redirected = addDelivery(db, subId, { at: c.value });
    const redirect = (async () =>
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } })) as unknown as typeof fetch;
    await runWebhookTickForTests(db, { fetchImpl: redirect, now: c.now, random: mid });
    expect(delivery(db, redirected.id)).toMatchObject({ status: "pending", lastStatusCode: 302 });
    expect(delivery(db, redirected.id).lastError).toContain("redirect not followed");

    const otherSub = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, secret: generateWebhookSecret() });
    const network = addDelivery(db, otherSub, { at: c.value });
    const refused = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await runWebhookTickForTests(db, { fetchImpl: refused, now: c.now, random: mid });
    expect(delivery(db, network.id)).toMatchObject({ status: "pending", attempts: 1, lastStatusCode: null });
    expect(delivery(db, network.id).lastError).toContain("ECONNREFUSED");
  });

  test("after 8 failed attempts the row is failed", async () => {
    const { db, subId } = setup();
    const c = clock();
    const d = addDelivery(db, subId, { at: c.value });
    const f = fakeFetch([], 500);

    for (let attempt = 1; attempt <= RETRY_SCHEDULE_MS.length + 1; attempt++) {
      const summary = await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: mid });
      expect(summary.claimed).toBe(1);
      const row = delivery(db, d.id);
      expect(row.attempts).toBe(attempt);
      if (attempt <= RETRY_SCHEDULE_MS.length) {
        expect(row.status).toBe("pending");
        expect(row.nextAttemptAt.getTime()).toBe(c.value + RETRY_SCHEDULE_MS[attempt - 1]);
        c.set(row.nextAttemptAt.getTime());
      } else {
        expect(row.status).toBe("failed");
        expect(row.lastStatusCode).toBe(500);
      }
    }
    expect(f.sent).toHaveLength(8);
    expect(new Set(f.sent.map((r) => r.headers["webhook-id"]))).toEqual(new Set([d.eventId]));
    c.advance(86_400_000);
    expect((await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now })).claimed).toBe(0);
    // The schedule spans ~28 h, well inside the 5-day auto-disable window.
    expect(sub(db, subId).enabled).toBe(true);
  });

  test("a 410 disables the subscription and fails its other pending rows", async () => {
    const { db, ctx, subId } = setup();
    const c = clock();
    const gone = addDelivery(db, subId, { at: c.value });
    const later = addDelivery(db, subId, { at: c.value + 60_000 });
    const otherSub = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, secret: generateWebhookSecret() });
    const unrelated = addDelivery(db, otherSub, { at: c.value + 60_000 });

    const summary = await runWebhookTickForTests(db, { fetchImpl: fakeFetch([410]).impl, now: c.now });
    expect(summary).toMatchObject({ claimed: 1, failed: 1 });
    expect(delivery(db, gone.id)).toMatchObject({
      status: "failed",
      lastStatusCode: 410,
      lastError: "410 Gone: subscription disabled",
      leaseUntil: null,
    });
    expect(delivery(db, later.id)).toMatchObject({ status: "failed", lastError: "subscription disabled" });
    expect(delivery(db, unrelated.id).status).toBe("pending");
    const s = sub(db, subId);
    expect(s.enabled).toBe(false);
    expect(s.disabledReason).toBe("gone");
    expect(s.disabledAt?.getTime()).toBe(c.value);
    expect(countEnabledWebhookSubscriptions(db)).toBe(1);
  });

  test("5 days of continuous failure disables with reason failing", async () => {
    const { db, subId } = setup();
    const c = clock();
    const f = fakeFetch([], 500);
    const t0 = c.value;

    addDelivery(db, subId, { at: c.value });
    await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: mid });
    expect(sub(db, subId).failingSince?.getTime()).toBe(t0);

    c.set(t0 + AUTO_DISABLE_AFTER_MS - 1);
    const almost = addDelivery(db, subId, { at: c.value });
    await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: mid });
    expect(sub(db, subId).enabled).toBe(true);
    expect(delivery(db, almost.id).status).toBe("pending");

    c.set(t0 + AUTO_DISABLE_AFTER_MS);
    const last = addDelivery(db, subId, { at: c.value });
    // The earlier rows are due again by now; all three fail in this tick.
    await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: mid });
    const s = sub(db, subId);
    expect(s.enabled).toBe(false);
    expect(s.disabledReason).toBe("failing");
    expect(s.failingSince?.getTime()).toBe(t0);
    expect(delivery(db, last.id).status).toBe("failed");
    expect(delivery(db, almost.id).status).toBe("failed");
  });

  test("a success in between resets failing_since", async () => {
    const { db, subId } = setup();
    const c = clock();
    const t0 = c.value;
    addDelivery(db, subId, { at: c.value });
    await runWebhookTickForTests(db, { fetchImpl: fakeFetch([500]).impl, now: c.now, random: mid });
    expect(sub(db, subId).failingSince?.getTime()).toBe(t0);

    // The retry succeeds a day later.
    c.set(t0 + 86_400_000);
    await runWebhookTickForTests(db, { fetchImpl: fakeFetch([200]).impl, now: c.now, random: mid });
    expect(sub(db, subId).failingSince).toBeNull();

    // A failure past the 5-day mark starts a fresh window instead of disabling.
    c.set(t0 + AUTO_DISABLE_AFTER_MS + 1);
    addDelivery(db, subId, { at: c.value });
    await runWebhookTickForTests(db, { fetchImpl: fakeFetch([500]).impl, now: c.now, random: mid });
    const s = sub(db, subId);
    expect(s.enabled).toBe(true);
    expect(s.failingSince?.getTime()).toBe(c.value);
    expect(s.consecutiveFailures).toBe(1);
  });

  test("AGENT_FS_WEBHOOK_AUTO_DISABLE_MS shortens the window", async () => {
    const { db, subId } = setup();
    const c = clock();
    const env = { AGENT_FS_WEBHOOK_AUTO_DISABLE_MS: "1000" };
    addDelivery(db, subId, { at: c.value });
    await runWebhookTickForTests(db, { fetchImpl: fakeFetch([], 500).impl, now: c.now, random: mid, env });
    expect(sub(db, subId).enabled).toBe(true);
    c.advance(1_000);
    addDelivery(db, subId, { at: c.value });
    await runWebhookTickForTests(db, { fetchImpl: fakeFetch([], 500).impl, now: c.now, random: mid, env });
    expect(sub(db, subId).disabledReason).toBe("failing");
  });

  test("a disabled subscription's rows are never claimed", async () => {
    const { db, ctx } = setup();
    const c = clock();
    const off = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, secret: generateWebhookSecret(), enabled: false });
    const d = addDelivery(db, off, { at: c.value });
    const f = fakeFetch();
    expect((await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now })).claimed).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect(delivery(db, d.id)).toMatchObject({ status: "pending", attempts: 0, leaseUntil: null });
  });

  test("restart: a claim whose process died is re-sent after its lease expires, with the same webhook-id", async () => {
    const { db, secret, subId } = setup();
    const c = clock();
    const d = addDelivery(db, subId, { at: c.value });
    const claimedAt = c.value;

    // The first process claims the row and dies before recording anything.
    const [claim] = claimDueDeliveries(db, { now: claimedAt, batch: 10 });
    expect(claim).toMatchObject({ id: d.id, eventId: d.eventId, attempts: 1, leaseUntil: claimedAt + LEASE_MS });
    expect(delivery(db, d.id).leaseUntil?.getTime()).toBe(claimedAt + LEASE_MS);

    // A new process: nothing is claimable while the lease is live.
    const f = fakeFetch();
    c.set(claimedAt + LEASE_MS);
    expect((await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now })).claimed).toBe(0);
    expect(f.sent).toHaveLength(0);

    // Once it expires, the row is re-claimed and sent with the same id.
    c.set(claimedAt + LEASE_MS + 1);
    const summary = await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: mid });
    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].headers["webhook-id"]).toBe(d.eventId);
    expect(new Webhook(secret).verify(f.sent[0].body, f.sent[0].headers)).toEqual(JSON.parse(d.payload));
    // The crash counted as an attempt.
    expect(delivery(db, d.id)).toMatchObject({ status: "delivered", attempts: 2 });
  });

  test("a live lease is not claimed twice, and a stale sender cannot overwrite the re-claim", async () => {
    const { db, subId } = setup();
    const c = clock();
    const d = addDelivery(db, subId, { at: c.value });
    const slow = hangingFetch({ honourAbort: false });

    const firstTick = runWebhookTickForTests(db, { fetchImpl: slow.impl, now: c.now, random: mid });
    await slow.firstRequest;

    // A concurrent tick while the lease holds claims nothing.
    const f = fakeFetch([200]);
    expect((await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now })).claimed).toBe(0);

    // The lease expires; a second tick re-claims and delivers.
    c.advance(LEASE_MS + 1);
    expect(await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, random: mid })).toMatchObject({
      claimed: 1,
      delivered: 1,
    });

    // The first sender finally gets a 500: its stale result changes nothing.
    slow.release(500);
    const stale = await firstTick;
    expect(stale).toMatchObject({ claimed: 1, delivered: 0, retrying: 0, failed: 0 });
    expect(delivery(db, d.id)).toMatchObject({ status: "delivered", attempts: 2, lastStatusCode: 200 });
    expect(sub(db, subId).consecutiveFailures).toBe(0);
  });

  test("the batch limits claims per tick, oldest due first", async () => {
    const { db, subId } = setup();
    const c = clock();
    const rows = [3, 1, 2].map((n) => ({ n, ...addDelivery(db, subId, { at: c.value - n * 1_000 }) }));
    const f = fakeFetch();
    expect((await runWebhookTickForTests(db, { fetchImpl: f.impl, now: c.now, batch: 2 })).claimed).toBe(2);
    expect(f.sent.map((r) => r.headers["webhook-id"]).sort()).toEqual(
      rows.filter((r) => r.n >= 2).map((r) => r.eventId).sort()
    );
  });
});

describe("startWebhookWorker / stopWebhookWorker", () => {
  test("refuses to start on an invalid allowlist", () => {
    const { db } = setup();
    expect(() => startWebhookWorker(db, { env: { AGENT_FS_WEBHOOK_ALLOWED_HOSTS: "not a host!" } })).toThrow();
  });

  test("stop awaits the in-flight tick", async () => {
    const { db, subId } = setup();
    const d = addDelivery(db, subId, { at: Date.now() });
    const slow = hangingFetch({ honourAbort: false });
    startWebhookWorker(db, { fetchImpl: slow.impl, pollMs: 60_000 });
    await slow.firstRequest;

    let stopped = false;
    const stopping = stopWebhookWorker().then(() => (stopped = true));
    await Bun.sleep(30);
    expect(stopped).toBe(false);

    slow.release(200);
    await stopping;
    expect(stopped).toBe(true);
    // The tick recorded its result before stop returned.
    expect(delivery(db, d.id).status).toBe("delivered");
  });

  test("stop aborts a hanging send and releases its lease for the next process", async () => {
    const { db, subId } = setup();
    const d = addDelivery(db, subId, { at: Date.now() });
    const slow = hangingFetch({ honourAbort: true });
    startWebhookWorker(db, { fetchImpl: slow.impl, pollMs: 60_000 });
    await slow.firstRequest;

    await stopWebhookWorker();
    const row = delivery(db, d.id);
    expect(row).toMatchObject({ status: "pending", attempts: 1, leaseUntil: null, lastError: null });
    // Stop is not the receiver's fault.
    expect(sub(db, subId)).toMatchObject({ consecutiveFailures: 0, failingSince: null });

    // The next process resends it at once, with the same webhook-id.
    const f = fakeFetch();
    expect(await runWebhookTickForTests(db, { fetchImpl: f.impl })).toMatchObject({ delivered: 1 });
    expect(slow.sent[0].headers["webhook-id"]).toBe(d.eventId);
    expect(f.sent[0].headers["webhook-id"]).toBe(d.eventId);
  });

  test("an enqueue triggers an early tick", async () => {
    const { db, ctx, secret } = setup();
    const mentioned = createUser(db, { email: "mentioned@example.com" }).user;
    grantOrgRole(db, { orgId: ctx.orgId, userId: mentioned.id, role: "editor" });
    grantDriveRole(db, { driveId: ctx.driveId, userId: mentioned.id, role: "editor" });
    const f = fakeFetch();
    // A poll far in the future: only the early tick can deliver in time.
    startWebhookWorker(db, { fetchImpl: f.impl, pollMs: 60_000 });
    await Bun.sleep(20); // The start tick finds nothing.
    expect(f.sent).toHaveLength(0);

    await commentAdd(ctx, { path: "/early.md", body: "hello", mentions: [mentioned.email] });
    const deadline = Date.now() + 2_000;
    while (f.sent.length < 2 && Date.now() < deadline) await Bun.sleep(10);

    // Both rows (created + mentioned) went out without waiting for a poll.
    expect(f.sent.map((r) => JSON.parse(r.body).type).sort()).toEqual(["comment.created", "comment.mentioned"]);
    for (const r of f.sent) expect(new Webhook(secret).verify(r.body, r.headers)).toBeTruthy();
  });

  test("notifyWebhooksEnqueued is a no-op once the worker stopped", async () => {
    const { db, subId } = setup();
    const f = fakeFetch();
    startWebhookWorker(db, { fetchImpl: f.impl, pollMs: 60_000 });
    await Bun.sleep(20);
    await stopWebhookWorker();
    addDelivery(db, subId, { at: Date.now() });
    notifyWebhooksEnqueued();
    await Bun.sleep(200);
    expect(f.sent).toHaveLength(0);
  });
});
