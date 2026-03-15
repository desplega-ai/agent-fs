import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

// Parse args
const args = process.argv.slice(2);
const embedded = args.includes("--embedded");
const daemon = args.includes("--daemon");

// Auto-detect mode
let mode: "embedded" | "daemon" = "embedded";

if (daemon) {
  mode = "daemon";
} else if (!embedded) {
  // Auto-detect: check if daemon is running
  try {
    const res = await fetch("http://localhost:7433/health");
    if (res.ok) {
      mode = "daemon";
    }
  } catch {
    mode = "embedded";
  }
}

const apiKey = process.env.AGENTFS_API_KEY;
const server = createMcpServer({ mode, apiKey });

const transport = new StdioServerTransport();
await server.connect(transport);
