import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegisteredOps, getOpDefinition, dispatchOp } from "@agentfs/core";
import type { OpContext } from "@agentfs/core";

// Register all ops from the core registry as MCP tools
export function registerTools(
  server: McpServer,
  getContext: () => OpContext
) {
  const ops = getRegisteredOps();

  for (const opName of ops) {
    const def = getOpDefinition(opName);
    if (!def) continue;

    // Convert Zod schema to a plain object shape for MCP
    // MCP SDK accepts Zod schemas directly
    server.tool(
      opName,
      `agentfs ${opName}`,
      def.schema instanceof z.ZodObject
        ? (def.schema as z.ZodObject<any>).shape
        : { params: z.any() },
      async (params: any) => {
        const ctx = getContext();
        const result = await dispatchOp(ctx, opName, params);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );
  }
}
