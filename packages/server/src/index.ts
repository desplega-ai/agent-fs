import { createDatabase, getConfig, AgentS3Client, createEmbeddingProviderFromEnv } from "@/core";
import type { EmbeddingProvider } from "@/core";
import { createApp } from "./app.js";

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

// Graceful shutdown
function shutdown() {
  console.log("Shutting down...");
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
