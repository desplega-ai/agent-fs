import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Webhook } from "standardwebhooks";
import { VERSION } from "../../version.js";
import { RESPONSE_SNIPPET_BYTES, sendWebhook } from "../sender.js";
import { decodeWebhookSecret, generateWebhookSecret, verifyWebhookSignature } from "../signature.js";

// A local receiver on 127.0.0.1, reachable only because the test allowlists
// its exact host:port. sendWebhook uses its default (egress-guarded) fetch.

interface Received {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

let server: Server<unknown>;
let base: string;
const received: Received[] = [];
const savedEnv = {
  allowed: process.env.AGENT_FS_WEBHOOK_ALLOWED_HOSTS,
  allowPrivate: process.env.AGENT_FS_WEBHOOK_ALLOW_PRIVATE,
};

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      received.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      });
      switch (url.pathname) {
        case "/ok":
          return new Response("thanks", { status: 200 });
        case "/accepted":
          return new Response(null, { status: 204 });
        case "/fail":
          return new Response("receiver exploded", { status: 500 });
        case "/big-fail":
          return new Response("x".repeat(RESPONSE_SNIPPET_BYTES * 8), { status: 503 });
        case "/gone":
          return new Response("bye", { status: 410 });
        case "/hang":
          await Bun.sleep(2_000);
          return new Response("late", { status: 200 });
        case "/to-metadata":
          return new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest/meta-data" } });
        case "/to-ok":
          return new Response(null, { status: 307, headers: { location: "/ok" } });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  process.env.AGENT_FS_WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${server.port}`;
  delete process.env.AGENT_FS_WEBHOOK_ALLOW_PRIVATE;
});

afterAll(() => {
  server.stop(true);
  for (const [name, value] of [
    ["AGENT_FS_WEBHOOK_ALLOWED_HOSTS", savedEnv.allowed],
    ["AGENT_FS_WEBHOOK_ALLOW_PRIVATE", savedEnv.allowPrivate],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  received.length = 0;
});

const secret = generateWebhookSecret();
const body = JSON.stringify({ type: "comment.created", timestamp: "2026-11-05T10:15:00.000Z", data: { n: 1 } });

describe("sendWebhook", () => {
  test("sends Standard Webhooks headers that both verifiers accept", async () => {
    const result = await sendWebhook({ url: `${base}/ok`, secret, webhookId: "evt_123", body });
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(received).toHaveLength(1);
    const [req] = received;
    expect(req.method).toBe("POST");
    expect(req.body).toBe(body);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["user-agent"]).toBe(`agent-fs-webhooks/${VERSION}`);
    expect(req.headers["webhook-id"]).toBe("evt_123");
    expect(req.headers["webhook-timestamp"]).toMatch(/^\d+$/);
    expect(Math.abs(Number(req.headers["webhook-timestamp"]) - Date.now() / 1000)).toBeLessThan(10);
    expect(req.headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);

    const key = decodeWebhookSecret(secret)!;
    expect(
      verifyWebhookSignature(key, req.body, {
        id: req.headers["webhook-id"],
        timestamp: req.headers["webhook-timestamp"],
        signature: req.headers["webhook-signature"],
      })
    ).toBe(true);
    // Independent oracle: the standardwebhooks npm library.
    expect(new Webhook(secret).verify(req.body, req.headers)).toEqual(JSON.parse(body));
    // A different secret fails both.
    const other = generateWebhookSecret();
    expect(() => new Webhook(other).verify(req.body, req.headers)).toThrow();
  });

  test("webhook-timestamp follows the injected clock", async () => {
    const now = () => Date.UTC(2026, 10, 5, 10, 15, 0) + 999;
    await sendWebhook({ url: `${base}/accepted`, secret, webhookId: "evt_clock", body, now });
    const [req] = received;
    expect(req.headers["webhook-timestamp"]).toBe(String(Math.floor(now() / 1000)));
    const key = decodeWebhookSecret(secret)!;
    expect(
      verifyWebhookSignature(
        key,
        req.body,
        {
          id: req.headers["webhook-id"],
          timestamp: req.headers["webhook-timestamp"],
          signature: req.headers["webhook-signature"],
        },
        {},
        now()
      )
    ).toBe(true);
  });

  test("a 2xx without a body is ok", async () => {
    const result = await sendWebhook({ url: `${base}/accepted`, secret, webhookId: "evt_204", body });
    expect(result).toMatchObject({ ok: true, statusCode: 204 });
  });

  test("a 500 is ok:false with the status and the body as error text", async () => {
    const result = await sendWebhook({ url: `${base}/fail`, secret, webhookId: "evt_500", body });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toBe("HTTP 500: receiver exploded");
  });

  test("keeps at most 1 KB of a failed response body", async () => {
    const result = await sendWebhook({ url: `${base}/big-fail`, secret, webhookId: "evt_503", body });
    expect(result).toMatchObject({ ok: false, statusCode: 503 });
    expect(result.error!.length).toBeLessThanOrEqual("HTTP 503: ".length + RESPONSE_SNIPPET_BYTES);
  });

  test("a 410 reports its status", async () => {
    const result = await sendWebhook({ url: `${base}/gone`, secret, webhookId: "evt_410", body });
    expect(result).toMatchObject({ ok: false, statusCode: 410 });
  });

  test("a receiver slower than the timeout gives an error, not a throw", async () => {
    const result = await sendWebhook({ url: `${base}/hang`, secret, webhookId: "evt_hang", body, timeoutMs: 150 });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeUndefined();
    expect(result.error).toBe("timed out after 150 ms");
    expect(result.durationMs).toBeLessThan(1_500);
  });

  test("a redirect to the metadata address is refused by the egress guard", async () => {
    const result = await sendWebhook({ url: `${base}/to-metadata`, secret, webhookId: "evt_redirect", body });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeUndefined();
    expect(result.error).toContain("Webhook egress refused");
    expect(result.error).toContain("169.254.169.254");
    // Only the first hop reached a server.
    expect(received.map((r) => r.path)).toEqual(["/to-metadata"]);
  });

  test("a same-host 307 redirect is followed with the same signed body", async () => {
    const result = await sendWebhook({ url: `${base}/to-ok`, secret, webhookId: "evt_307", body });
    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(received.map((r) => r.path)).toEqual(["/to-ok", "/ok"]);
    expect(new Webhook(secret).verify(received[1].body, received[1].headers)).toEqual(JSON.parse(body));
  });

  test("a non-allowlisted private target is refused without a request", async () => {
    const result = await sendWebhook({ url: "http://10.0.0.5/hook", secret, webhookId: "evt_priv", body });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Webhook egress refused");
    expect(received).toHaveLength(0);
  });

  test("a network error becomes error", async () => {
    // A closed port on the allowlisted host: the guard passes, connect fails.
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    const saved = process.env.AGENT_FS_WEBHOOK_ALLOWED_HOSTS;
    process.env.AGENT_FS_WEBHOOK_ALLOWED_HOSTS = `${saved},127.0.0.1:${port}`;
    try {
      const result = await sendWebhook({ url: `http://127.0.0.1:${port}/x`, secret, webhookId: "evt_net", body });
      expect(result.ok).toBe(false);
      expect(result.statusCode).toBeUndefined();
      expect(result.error).toBeTruthy();
    } finally {
      process.env.AGENT_FS_WEBHOOK_ALLOWED_HOSTS = saved;
    }
  });

  test("an undecodable secret becomes error instead of throwing", async () => {
    const result = await sendWebhook({ url: `${base}/ok`, secret: "whsec_!!!", webhookId: "evt_bad", body });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("signWebhook");
    expect(received).toHaveLength(0);
  });
});
