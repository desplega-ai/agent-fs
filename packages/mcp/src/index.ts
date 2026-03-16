import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

const apiKey = process.env.AGENT_FS_API_KEY;
const server = await createMcpServer({ apiKey });

const transport = new StdioServerTransport();
await server.connect(transport);
