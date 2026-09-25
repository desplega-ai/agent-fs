/**
 * Anonymized usage telemetry, sent to the Desplega telemetry proxy.
 *
 * Only the API server sends events: `server.started` at boot and
 * `server.heartbeat` every 24h with aggregate counts, plus a final
 * `server.heartbeat` on graceful shutdown so a restart never drops counts. No file paths, file
 * content, names, emails, hostnames, or keys ever leave the process.
 *
 * Opt out with `ANONYMIZED_TELEMETRY=false` or `DO_NOT_TRACK=1`.
 * Mirrors agent-swarm's `src/telemetry.ts`: no dependencies, fire-and-forget.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getConfig, getConfigPath } from "./config.js";
import { VERSION } from "./version.js";

const TELEMETRY_ENDPOINT = "https://proxy.desplega.sh/v1/events";
const PRODUCT = "agent-fs";
const TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Upper bound on how long a shutdown waits for the final heartbeat. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 1_500;

const FALSY = new Set(["false", "0", "no", "off"]);
const KNOWN_STORAGE_PROVIDERS = new Set(["minio", "s3", "r2", "tigris", "local"]);
const KNOWN_EMBEDDING_PROVIDERS = new Set(["local", "openai", "gemini"]);

type Props = Record<string, string | number | boolean>;

/** Read on every call so a changed env takes effect without a restart. */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ANONYMIZED_TELEMETRY?.trim().toLowerCase();
  if (flag && FALSY.has(flag)) return false;
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt && !FALSY.has(dnt)) return false;
  return true;
}

function isCloud(): boolean {
  const flag = process.env.AGENT_FS_CLOUD?.trim().toLowerCase();
  return flag === "true" || flag === "1";
}

function getEnvironment(): string {
  const explicit = process.env.DESPLEGA_TELEMETRY_ENV?.trim();
  if (explicit) return explicit;
  return process.env.NODE_ENV === "test" ? "test" : "production";
}

/**
 * Return the persisted install ID, minting one on first use. Writes only the
 * `telemetry.installId` key into the raw config file so env-derived overrides
 * (S3 keys, etc.) are never persisted as a side effect.
 */
export function getOrCreateInstallId(): string {
  const existing = getConfig().telemetry?.installId;
  if (existing) return existing;

  const installId = `install_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    const path = getConfigPath();
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
    raw.telemetry = { ...(raw.telemetry ?? {}), installId };
    writeFileSync(path, JSON.stringify(raw, null, 2));
    return installId;
  } catch {
    // Unwritable config: use a per-process ID rather than failing startup.
    return `ephemeral_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }
}

const opCounts = new Map<string, number>();

/** Count one successful op. Drained into the next heartbeat. */
export function recordOp(name: string): void {
  opCounts.set(name, (opCounts.get(name) ?? 0) + 1);
}

export function hasPendingOps(): boolean {
  return opCounts.size > 0;
}

export function drainOpCounts(): Props {
  const counts: Props = {};
  let total = 0;
  for (const [name, count] of opCounts) {
    counts[`ops_${name.replace(/-/g, "_")}`] = count;
    total += count;
  }
  opCounts.clear();
  counts.ops_total = total;
  return counts;
}

/**
 * Fire-and-forget. Never throws, never blocks. The returned promise settles
 * when the request finishes or times out; callers may ignore it.
 */
export function track(
  installId: string,
  event: string,
  properties: Props = {},
  timeoutMs: number = TIMEOUT_MS,
): Promise<void> {
  if (!isTelemetryEnabled()) return Promise.resolve();
  try {
    const payload = {
      product: PRODUCT,
      event,
      occurred_at: new Date().toISOString(),
      source: "api-server",
      actor_mode: "anonymous",
      actor_anonymous_id: installId,
      properties: {
        ...properties,
        // Spread last so callers cannot spoof the cohort fields.
        is_cloud: isCloud(),
        version: VERSION,
      },
      metadata: {
        transport: "https",
        schema_version: 1,
        environment: getEnvironment(),
        is_cloud: isCloud(),
      },
    };
    return fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    }).then(
      () => {},
      () => {},
    );
  } catch {
    // Never throw
    return Promise.resolve();
  }
}

function countRows(sqlite: Database, sql: string): number {
  try {
    const row = sqlite.query(sql).get() as { n: number } | null;
    return row?.n ?? 0;
  } catch {
    return -1;
  }
}

/** Aggregate, non-identifying snapshot of this install. */
export function collectServerStats(sqlite: Database): Props {
  const config = getConfig();
  const storage = config.s3.provider.toLowerCase();
  const embedding = config.embedding.provider;
  return {
    users: countRows(sqlite, "SELECT count(*) AS n FROM users"),
    orgs: countRows(sqlite, "SELECT count(*) AS n FROM orgs"),
    drives: countRows(sqlite, "SELECT count(*) AS n FROM drives"),
    files: countRows(sqlite, "SELECT count(*) AS n FROM files WHERE is_deleted = 0"),
    storage_provider: KNOWN_STORAGE_PROVIDERS.has(storage) ? storage : "other",
    embedding_provider: KNOWN_EMBEDDING_PROVIDERS.has(embedding) ? embedding : "other",
    os: process.platform,
    arch: process.arch,
  };
}

/**
 * Send `server.started` now and `server.heartbeat` every 24h.
 * Returns a stop function. Stopping flushes ops counted since the last
 * heartbeat as a final `server.heartbeat` with `shutdown: true`; the returned
 * promise settles within SHUTDOWN_FLUSH_TIMEOUT_MS. A no-op when telemetry
 * is disabled at boot.
 */
export function startServerTelemetry(sqlite: Database): () => Promise<void> {
  const noop = () => Promise.resolve();
  if (!isTelemetryEnabled()) return noop;
  let installId: string;
  try {
    installId = getOrCreateInstallId();
  } catch {
    return noop;
  }

  const safeStats = (): Props => {
    try {
      return collectServerStats(sqlite);
    } catch {
      return {};
    }
  };

  track(installId, "server.started", safeStats());
  const timer = setInterval(() => {
    track(installId, "server.heartbeat", { ...safeStats(), ...drainOpCounts() });
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();

  let stopped = false;
  return () => {
    if (stopped) return Promise.resolve();
    stopped = true;
    clearInterval(timer);
    if (!hasPendingOps()) return Promise.resolve();
    const flush = track(
      installId,
      "server.heartbeat",
      { ...safeStats(), ...drainOpCounts(), shutdown: true },
      SHUTDOWN_FLUSH_TIMEOUT_MS,
    );
    // Hard cap in case fetch ignores the abort signal.
    const cap = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS).unref());
    return Promise.race([flush, cap]);
  };
}
