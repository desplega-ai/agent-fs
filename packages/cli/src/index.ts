#!/usr/bin/env bun
import { Command } from "commander";
import { getConfig, listUserOrgs, getUserByApiKey, VERSION } from "@agentfs/core";
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
  .name("agentfs")
  .description("Agent-first filesystem backed by S3")
  .version(VERSION)
  .option("--org <orgId>", "Override org context")
  .option("--drive <driveId>", "Override drive context");

const client = new ApiClient();

// Resolve the default org ID
function getOrgId(): string {
  const orgId = program.opts().org;
  if (orgId) return orgId;

  // Try to resolve from config
  const config = getConfig();
  if (config.auth.apiKey) {
    try {
      const { createDatabase } = require("@agentfs/core");
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

  console.error("Error: No org context. Use --org or run 'agentfs auth register'");
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
  .option("--embedded", "Force embedded mode (no daemon)")
  .option("--daemon", "Force daemon mode (requires running daemon)")
  .action(async () => {
    await import("@agentfs/mcp/src/index.js");
  });

// Server command (foreground dev mode)
program
  .command("server")
  .description("Run server in foreground (dev mode)")
  .action(async () => {
    await import("@agentfs/server/src/index.js");
  });

program.parse();
