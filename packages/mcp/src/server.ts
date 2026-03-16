import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createDatabase,
  getConfig,
  AgentS3Client,
  resolveContext,
  getUserByApiKey,
  ensureLocalUser,
  createEmbeddingProviderFromEnv,
  VERSION,
} from "@/core";
import type { OpContext, DB } from "@/core";
import { registerTools } from "./tools.js";

export interface McpServerOptions {
  apiKey?: string;
}

export async function createMcpServer(options: McpServerOptions) {
  const server = new McpServer({
    name: "agent-fs",
    version: VERSION,
  });

  const config = getConfig();

  // Await embedding provider before registering tools to avoid race condition
  const embeddingProvider = await createEmbeddingProviderFromEnv(config.embedding);
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
      embeddingProvider,
    };
  };

  registerTools(server, getContext);
  console.error("[agent-fs] MCP server ready");

  return server;
}
