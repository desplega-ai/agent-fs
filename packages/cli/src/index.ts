#!/usr/bin/env bun
import { Command } from "commander";
import { getConfig, listUserOrgs, getUserByApiKey, VERSION } from "@/core";
import { ApiClient } from "./api-client.js";
import { registerOpCommands } from "./commands/ops.js";
import { authCommands } from "./commands/auth.js";
import { daemonCommands } from "./commands/daemon.js";
import { configCommands } from "./commands/config-cmd.js";
import { driveCommands } from "./commands/drive.js";
import { initCommand } from "./commands/init.js";
import { commentCommands } from "./commands/comment.js";

const program = new Command();

program
  .name("agent-fs")
  .description("Agent-first filesystem backed by S3")
  .version(VERSION)
  .option("--org <orgId>", "Override org context")
  .option("--drive <driveId>", "Override drive context")
  .option("--json", "Output raw JSON");

const client = new ApiClient();

// Resolve the default org ID
function getOrgId(): string {
  const orgId = program.opts().org;
  if (orgId) return orgId;

  // Try to resolve from config
  const config = getConfig();
  if (config.auth.apiKey) {
    try {
      const { createDatabase } = require("@/core");
      const db = createDatabase();
      const user = getUserByApiKey(db, config.auth.apiKey);
      if (user) {
        const orgs = listUserOrgs(db, user.id);
        if (orgs.length > 0) return orgs[0].id;
      }
    } catch {
      // If DB isn't available, let the server handle it
    }
  }

  console.error("Error: No org context. Use --org or run 'agent-fs auth register'");
  process.exit(1);
}

// Register commands
registerOpCommands(program, client, getOrgId);
program.addCommand(authCommands(client));
program.addCommand(daemonCommands());
program.addCommand(configCommands());
program.addCommand(driveCommands(client));
program.addCommand(initCommand());
program.addCommand(commentCommands(client, getOrgId));

// MCP command
program
  .command("mcp")
  .description("Start MCP server (stdio)")
  .action(async () => {
    await import("@/mcp/index.js");
  });

// Server command (foreground dev mode)
program
  .command("server")
  .description("Run server in foreground (dev mode)")
  .action(async () => {
    await import("@/server/index.js");
  });

// Show global options in subcommand help
const globalHelp = `
Global Options:
  --org <orgId>    Override org context
  --drive <driveId>  Override drive context
  --json           Output raw JSON
`;
for (const cmd of program.commands) {
  cmd.addHelpText("after", globalHelp);
}

program.parse();
