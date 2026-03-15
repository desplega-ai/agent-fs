import { createDatabase, getConfig, AgentS3Client } from "@agentfs/core";
import { createApp } from "./app.js";

const config = getConfig();

// Initialize database
const db = createDatabase();

// Initialize S3 client
const s3 = new AgentS3Client(config.s3);

// Create app
const app = createApp(db, s3);

// Start server
const server = Bun.serve({
  fetch: app.fetch,
  port: config.server.port,
  hostname: config.server.host,
});

console.log(`agentfs daemon running on http://${server.hostname}:${server.port}`);

// Graceful shutdown
function shutdown() {
  console.log("Shutting down...");
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
