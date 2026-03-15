import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createDatabase,
  getConfig,
  AgentS3Client,
  resolveContext,
  getUserByApiKey,
  createUser,
  listUserOrgs,
  setConfigValue,
} from "@agentfs/core";
import type { OpContext, DB } from "@agentfs/core";
import { registerTools } from "./tools.js";

export interface McpServerOptions {
  mode: "embedded" | "daemon";
  apiKey?: string;
}

/**
 * In embedded mode, auto-bootstrap a local user if none exists.
 * Local mode should just work — no registration ceremony needed.
 */
function ensureLocalUser(db: DB): { apiKey: string } {
  const config = getConfig();
  if (config.auth.apiKey) {
    const user = getUserByApiKey(db, config.auth.apiKey);
    if (user) return { apiKey: config.auth.apiKey };
  }

  // No valid user — create one automatically
  console.error("[agent-fs] No local user found, creating one...");
  const result = createUser(db, { email: "local@agentfs.local" });
  setConfigValue("auth.apiKey", result.apiKey);
  console.error("[agent-fs] Local user created automatically.");
  return { apiKey: result.apiKey };
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

    // Auto-bootstrap local user — no manual registration needed
    const { apiKey } = options.apiKey
      ? { apiKey: options.apiKey }
      : ensureLocalUser(db);

    const getContext = (): OpContext => {
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
    console.error("[agent-fs] Running in embedded mode");
  } else {
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
