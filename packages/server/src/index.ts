import {
  createDatabase,
  getConfig,
  getDbPath,
  getHome,
  createStorageAdapter,
  createEmbeddingProviderFromEnv,
  prepareFtsMigration,
  runFtsMigration,
  CONTENT_CHUNKS_INDEX_NAME,
  hasContentChunksIndex,
  buildContentChunksIndexInHelperProcess,
} from "@/core";
import type { Database } from "bun:sqlite";
import type { EmbeddingProvider } from "@/core";
import { join } from "node:path";
import { createApp } from "./app.js";
import { startIpcServer } from "./ipc/server.js";
import { setUpgradeInProgress, clearUpgradeInProgress } from "./upgrade-gate.js";

const config = getConfig();

// Initialize database. The content_chunks index is left unbuilt on a large
// existing database so the build cannot block /health; it runs below, after
// the listener is open.
const db = createDatabase(undefined, { deferContentChunksIndex: true });
const sqlite = (db as any).$client as Database;

// Databases from before 0.13.1 carry the old full-text index layout. Swap the
// name over now (instant DDL) so every write from here on lands in the new
// layout; the row copy itself runs in the background once we are listening,
// in small batches, so /health keeps answering and a restart resumes it.
const ftsMigrationPending = prepareFtsMigration(sqlite);

// Initialize the storage adapter for the configured backend (S3/MinIO or
// local-FS). The factory also applies the test-only AGENT_FS_CAPABILITY_OVERRIDE
// overlay used by the e2e suite (folded in from here in step-4).
const s3 = createStorageAdapter(config.s3);

// Reconcile the advertised versioning capability with the backend's ACTUAL
// state. The S3 adapter otherwise derives `versioningEnabled` purely from a
// config flag that onboarding never writes, so a bucket with versioning enabled
// would report `versioning: false` and the revert/diff capability gate would
// wrongly reject operations that would in fact succeed. checkVersioningEnabled()
// queries the bucket (the local-FS adapter returns true unconditionally). The
// test-only AGENT_FS_CAPABILITY_OVERRIDE (applied in the factory via
// Object.defineProperty) shadows the `capabilities` getter, so this field write
// cannot clobber a forced-off override used by the e2e gating tests.
try {
  s3.versioningEnabled = await s3.checkVersioningEnabled();
} catch (err) {
  console.warn("Could not reconcile storage versioning capability:", err);
}

// Initialize embedding provider (graceful failure — semantic search unavailable if this fails)
let embeddingProvider: EmbeddingProvider | null = null;
try {
  embeddingProvider = await createEmbeddingProviderFromEnv(config.embedding);
} catch (err) {
  console.warn("Embedding provider unavailable, semantic search disabled:", err);
}

// Create app
const app = createApp(db, s3, embeddingProvider);

// Start server
const server = Bun.serve({
  fetch: app.fetch,
  port: config.server.port,
  hostname: config.server.host,
});

console.log(`agent-fs daemon running on http://${server.hostname}:${server.port}`);

const startBackgroundMigrations = () => {
  if (ftsMigrationPending) {
    runFtsMigration(sqlite, { log: (msg) => console.log(msg) }).catch((err) => {
      console.error("search index migration failed (will resume on next start):", err);
    });
  }
};

// A database from before 0.13.1 has no content_chunks index yet. Build it in
// a helper process so this loop, and /health, stay responsive; gate HTTP
// writes with 503 meanwhile. The FTS row copy waits for it so the two
// write-heavy jobs do not fight over the write lock.
if (!hasContentChunksIndex(sqlite)) {
  setUpgradeInProgress(`${CONTENT_CHUNKS_INDEX_NAME} build`);
  console.log(
    `search index upgrade: building ${CONTENT_CHUNKS_INDEX_NAME} in a helper process; writes return 503 until it finishes`,
  );
  buildContentChunksIndexInHelperProcess(getDbPath())
    .then(({ elapsedMs }) => {
      console.log(`search index upgrade: ${CONTENT_CHUNKS_INDEX_NAME} built in ${elapsedMs}ms`);
    })
    .catch((err) => {
      console.error(
        `search index upgrade: ${CONTENT_CHUNKS_INDEX_NAME} build failed; writes resume on the slow path and the build retries on next start:`,
        err,
      );
    })
    .finally(() => {
      clearUpgradeInProgress();
      startBackgroundMigrations();
    });
} else {
  startBackgroundMigrations();
}

// Event-loop lag watchdog. A synchronous operation that blocks the loop
// (the prod wedge: /health dead for minutes while the process sits at
// ~7% CPU) delays this timer along with everything else — when the loop
// finally unblocks, we log how long it was stalled so the incident can be
// correlated with the request-log's unmatched `-->` lines. It cannot fire
// DURING a permanent wedge; the request start-lines cover that case.
let watchdogLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const stalledMs = now - watchdogLast - 1_000;
  if (stalledMs > 5_000) {
    console.error(
      `event-loop was blocked for ~${(stalledMs / 1000).toFixed(1)}s ` +
        `(rss=${Math.round(process.memoryUsage.rss() / 1024 / 1024)}MB)`,
    );
  }
  watchdogLast = now;
}, 1_000).unref();

// Start the IPC listener on a Unix socket alongside the HTTP listener.
// The FUSE helper connects here for length-prefixed-msgpack request /
// response. Failures here don't take down the HTTP listener — we log and
// continue (HTTP-only operation remains valid).
const socketPath = join(getHome(), "agent-fs.sock");
let ipcServer: ReturnType<typeof startIpcServer> | null = null;
try {
  ipcServer = startIpcServer(socketPath, {
    db,
    s3,
    embeddingProvider,
    appUrl: config.appUrl,
    resolveApiKey: () => config.auth?.apiKey ?? null,
  });
  console.log(`agent-fs IPC listening on ${socketPath}`);
} catch (err) {
  console.warn("IPC listener unavailable:", err);
}

// Graceful shutdown
function shutdown() {
  console.log("Shutting down...");
  server.stop();
  if (ipcServer) ipcServer.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
