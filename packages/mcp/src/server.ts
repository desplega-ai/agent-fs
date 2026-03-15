import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createDatabase,
  getConfig,
  AgentS3Client,
  resolveContext,
  getUserByApiKey,
} from "@agentfs/core";
import type { OpContext, DB } from "@agentfs/core";
import { registerTools } from "./tools.js";

export interface McpServerOptions {
  mode: "embedded" | "daemon";
  apiKey?: string;
}

export function createMcpServer(options: McpServerOptions) {
  const server = new McpServer({
    name: "agent-fs",
    version: "0.1.0",
  });

  if (options.mode === "embedded") {
    const config = getConfig();
    const db = createDatabase();
    const s3 = new AgentS3Client(config.s3);
    const apiKey = options.apiKey ?? config.auth.apiKey;

    const getContext = (): OpContext => {
      if (!apiKey) {
        throw new Error("No API key configured. Run: agentfs auth register <email>");
      }

      const user = getUserByApiKey(db, apiKey);
      if (!user) throw new Error("Invalid API key");

      const resolved = resolveContext(db, { userId: user.id });
      return {
        db,
        s3,
        orgId: resolved.orgId,
        driveId: resolved.driveId,
        userId: user.id,
      };
    };

    registerTools(server, getContext);
    console.error("[agent-fs] Running in embedded mode (no daemon needed)");
  } else {
    // Daemon mode — tools call the HTTP API
    // For now, use embedded mode logic (daemon HTTP proxy can be added later)
    const config = getConfig();
    const db = createDatabase();
    const s3 = new AgentS3Client(config.s3);
    const apiKey = options.apiKey ?? config.auth.apiKey;

    const getContext = (): OpContext => {
      if (!apiKey) throw new Error("No API key. Set AGENTFS_API_KEY env var.");
      const user = getUserByApiKey(db, apiKey);
      if (!user) throw new Error("Invalid API key");
      const resolved = resolveContext(db, { userId: user.id });
      return { db, s3, orgId: resolved.orgId, driveId: resolved.driveId, userId: user.id };
    };

    registerTools(server, getContext);
    console.error("[agent-fs] Running in daemon mode");
  }

  return server;
}
