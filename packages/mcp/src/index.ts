import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getConfig, VERSION } from "@/core";

const config = getConfig();
const apiUrl = process.env.AGENT_FS_API_URL ?? config.apiUrl ?? `http://${config.server.host}:${config.server.port}`;
const apiKey = process.env.AGENT_FS_API_KEY ?? config.apiKey ?? config.auth?.apiKey;

if (!apiKey) {
  console.error("Error: No API key. Register with `agent-fs auth register` or set AGENT_FS_API_KEY.");
  process.exit(1);
}

// HTTP client → daemon's /mcp endpoint
const httpTransport = new StreamableHTTPClientTransport(
  new URL(`${apiUrl}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }
);

const client = new Client({ name: "agent-fs-proxy", version: VERSION });

try {
  await client.connect(httpTransport);
} catch (err) {
  console.error(
    `Cannot connect to agent-fs at ${apiUrl}.\n` +
    `Start a daemon with \`agent-fs daemon start\` or set AGENT_FS_API_URL to connect to a remote server.`
  );
  process.exit(1);
}

// stdio server → Claude Code
const server = new Server(
  { name: "agent-fs", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return await client.listTools();
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return await client.callTool(request.params);
});

const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);

console.error("[agent-fs] MCP proxy connected to " + apiUrl);
