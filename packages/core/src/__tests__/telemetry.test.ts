import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import {
  isTelemetryEnabled,
  getOrCreateInstallId,
  recordOp,
  drainOpCounts,
  track,
  startServerTelemetry,
  SHUTDOWN_FLUSH_TIMEOUT_MS,
} from "../telemetry.js";
import { getConfig, getConfigPath } from "../config.js";
import { createTestConfigDir, createTestDb } from "../test-utils.js";

const ENV_KEYS = [
  "ANONYMIZED_TELEMETRY",
  "DO_NOT_TRACK",
  "AGENT_FS_CLOUD",
  "S3_BUCKET",
  "S3_PROVIDER",
  "AGENT_FS_STORAGE_PROVIDER",
  "EMBEDDING_PROVIDER",
];

let cleanup: () => void;
let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;
let calls: { url: string; body: any }[];

beforeEach(() => {
  ({ cleanup } = createTestConfigDir());
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) process.env[k] = "";
  savedFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  drainOpCounts();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanup();
});

describe("isTelemetryEnabled", () => {
  test("on by default", () => {
    expect(isTelemetryEnabled({})).toBe(true);
  });

  test("ANONYMIZED_TELEMETRY=false turns it off", () => {
    expect(isTelemetryEnabled({ ANONYMIZED_TELEMETRY: "false" })).toBe(false);
    expect(isTelemetryEnabled({ ANONYMIZED_TELEMETRY: "0" })).toBe(false);
    expect(isTelemetryEnabled({ ANONYMIZED_TELEMETRY: "true" })).toBe(true);
  });

  test("DO_NOT_TRACK turns it off unless empty or falsy", () => {
    expect(isTelemetryEnabled({ DO_NOT_TRACK: "1" })).toBe(false);
    expect(isTelemetryEnabled({ DO_NOT_TRACK: "true" })).toBe(false);
    expect(isTelemetryEnabled({ DO_NOT_TRACK: "0" })).toBe(true);
    expect(isTelemetryEnabled({ DO_NOT_TRACK: "" })).toBe(true);
  });
});

describe("getOrCreateInstallId", () => {
  test("mints once and persists", () => {
    const id = getOrCreateInstallId();
    expect(id).toMatch(/^install_[0-9a-f]{16}$/);
    expect(getOrCreateInstallId()).toBe(id);
    expect(getConfig().telemetry?.installId).toBe(id);
  });

  test("keeps other keys and never persists env overrides", () => {
    getConfig(); // writes the default config file
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    raw.defaultOrg = "org-1";
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    process.env.S3_BUCKET = "from-env-bucket";

    getOrCreateInstallId();

    const after = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    expect(after.defaultOrg).toBe("org-1");
    expect(after.s3.bucket).not.toBe("from-env-bucket");
  });
});

describe("track", () => {
  test("posts an anonymous agent-fs event to the proxy", () => {
    process.env.AGENT_FS_CLOUD = "true";
    track("install_abc", "server.started", { users: 2, is_cloud: false });

    expect(calls).toHaveLength(1);
    const { url, body } = calls[0];
    expect(url).toBe("https://proxy.desplega.sh/v1/events");
    expect(body.product).toBe("agent-fs");
    expect(body.event).toBe("server.started");
    expect(body.actor_mode).toBe("anonymous");
    expect(body.actor_anonymous_id).toBe("install_abc");
    expect(body.properties.users).toBe(2);
    // Cohort fields cannot be spoofed by callers.
    expect(body.properties.is_cloud).toBe(true);
    expect(typeof body.properties.version).toBe("string");
    expect(body.metadata.environment).toBe("test");
  });

  test("sends nothing when disabled", () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    track("install_abc", "server.started");
    expect(calls).toHaveLength(0);
  });

  test("never throws when fetch rejects", () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(() => track("install_abc", "server.started")).not.toThrow();
  });
});

describe("op counters", () => {
  test("drain returns per-op counts and a total, then resets", () => {
    recordOp("write");
    recordOp("write");
    recordOp("vec-search");
    expect(drainOpCounts()).toEqual({ ops_write: 2, ops_vec_search: 1, ops_total: 3 });
    expect(drainOpCounts()).toEqual({ ops_total: 0 });
  });
});

describe("startServerTelemetry", () => {
  const sqliteOf = () => (createTestDb() as any).$client as Database;

  test("sends server.started with aggregate counts only", () => {
    const stop = startServerTelemetry(sqliteOf());
    stop();

    expect(calls).toHaveLength(1);
    const props = calls[0].body.properties;
    expect(calls[0].body.event).toBe("server.started");
    expect(props.users).toBe(0);
    expect(props.files).toBe(0);
    expect(props.storage_provider).toBe("minio");
    expect(props.embedding_provider).toBe("local");
    expect(calls[0].body.actor_anonymous_id).toBe(getConfig().telemetry?.installId);
  });

  test("disabled: no event and no install ID written", () => {
    process.env.DO_NOT_TRACK = "1";
    startServerTelemetry(sqliteOf())();
    expect(calls).toHaveLength(0);
    expect(getConfig().telemetry?.installId).toBeUndefined();
  });

  test("stop flushes pending ops as a final shutdown heartbeat", async () => {
    const stop = startServerTelemetry(sqliteOf());
    recordOp("write");
    recordOp("write");
    await stop();

    expect(calls.map((c) => c.body.event)).toEqual(["server.started", "server.heartbeat"]);
    const props = calls[1].body.properties;
    expect(props.shutdown).toBe(true);
    expect(props.ops_write).toBe(2);
    expect(props.ops_total).toBe(2);
    expect(drainOpCounts()).toEqual({ ops_total: 0 });

    await stop();
    expect(calls).toHaveLength(2);
  });

  test("stop sends nothing extra when no ops were counted", async () => {
    const stop = startServerTelemetry(sqliteOf());
    await stop();
    expect(calls.map((c) => c.body.event)).toEqual(["server.started"]);
  });

  test("stop is bounded when the endpoint hangs", async () => {
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    const stop = startServerTelemetry(sqliteOf());
    recordOp("read");
    const t0 = Date.now();
    await stop();
    expect(Date.now() - t0).toBeLessThan(SHUTDOWN_FLUSH_TIMEOUT_MS + 500);
  });

  test("disabled: stop flushes nothing", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    const stop = startServerTelemetry(sqliteOf());
    recordOp("write");
    await stop();
    expect(calls).toHaveLength(0);
    drainOpCounts();
  });
});
