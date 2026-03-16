import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createDatabase,
  getConfig,
  AgentS3Client,
  resolveContext,
  getUserByApiKey,
  ensureLocalUser,
  VERSION,
} from "@agentfs/core";
import type { OpContext, DB } from "@agentfs/core";
import type { EmbeddingProvider } from "@agentfs/core/src/search/embeddings/provider.js";
import { registerTools } from "./tools.js";

export interface McpServerOptions {
  apiKey?: string;
}

/**
 * Auto-detect and create an embedding provider based on available env vars.
 * Returns null if no provider can be configured.
 */
async function createEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  if (process.env.OPENAI_API_KEY) {
    try {
      const { OpenAIEmbeddingProvider } = await import(
        "@agentfs/core/src/search/embeddings/openai.js"
      );
      console.error("[agent-fs] Using OpenAI embedding provider");
      return new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY);
    } catch (e) {
      console.error("[agent-fs] Failed to load OpenAI provider:", e);
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const { GeminiEmbeddingProvider } = await import(
        "@agentfs/core/src/search/embeddings/gemini.js"
      );
      console.error("[agent-fs] Using Gemini embedding provider");
      return new GeminiEmbeddingProvider(process.env.GEMINI_API_KEY);
    } catch (e) {
      console.error("[agent-fs] Failed to load Gemini provider:", e);
    }
  }

  console.error(
    "[agent-fs] No embedding provider configured. Set OPENAI_API_KEY or GEMINI_API_KEY for semantic search."
  );
  return null;
}

export async function createMcpServer(options: McpServerOptions) {
  const server = new McpServer({
    name: "agent-fs",
    version: VERSION,
  });

  // Await embedding provider before registering tools to avoid race condition
  const embeddingProvider = await createEmbeddingProvider();

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
      embeddingProvider,
    };
  };

  registerTools(server, getContext);
  console.error("[agent-fs] MCP server ready");

  return server;
}
