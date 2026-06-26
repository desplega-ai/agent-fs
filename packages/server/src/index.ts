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

// TEST-ONLY: overlay the adapter's advertised capabilities from a JSON env var
// (e.g. AGENT_FS_CAPABILITY_OVERRIDE='{"versioning":false}'). This lets the e2e
// suite drive the UNSUPPORTED_OPERATION path against a real backend that would
// otherwise have the capability. Not for production use — gated on the env var
// being present. (step-4 may fold this into the storage adapter factory.)
const capOverrideRaw = process.env.AGENT_FS_CAPABILITY_OVERRIDE;
if (capOverrideRaw) {
  try {
    const override = JSON.parse(capOverrideRaw);
    const merged = { ...s3.capabilities, ...override };
    Object.defineProperty(s3, "capabilities", {
      value: merged,
      configurable: true,
    });
    console.warn("[test-only] AGENT_FS_CAPABILITY_OVERRIDE applied:", merged);
  } catch (err) {
    console.warn("Failed to parse AGENT_FS_CAPABILITY_OVERRIDE:", err);
  }
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
