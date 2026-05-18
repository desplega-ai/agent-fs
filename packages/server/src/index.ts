import { createDatabase, getConfig, getHome, AgentS3Client, createEmbeddingProviderFromEnv } from "@/core";
import type { EmbeddingProvider } from "@/core";
import { join } from "node:path";
import { createApp } from "./app.js";
import { startIpcServer } from "./ipc/server.js";

const config = getConfig();

// Initialize database
const db = createDatabase();

// Initialize S3 client
const s3 = new AgentS3Client(config.s3);

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
