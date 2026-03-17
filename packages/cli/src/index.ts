#!/usr/bin/env bun
import { Command } from "commander";
import { VERSION, getConfig } from "@/core";
import { ApiClient } from "./api-client.js";
import { registerOpCommands } from "./commands/ops.js";
import { authCommands } from "./commands/auth.js";
import { daemonCommands } from "./commands/daemon.js";
import { configCommands } from "./commands/config-cmd.js";
import { driveCommands } from "./commands/drive.js";
import { orgCommands } from "./commands/org.js";
import { initCommand } from "./commands/init.js";
import { onboardCommand } from "./commands/onboard.js";
import { commentCommands } from "./commands/comment.js";
import { docsCommand } from "./commands/docs.js";

const program = new Command();

program
  .name("agent-fs")
  .description("Agent-first filesystem backed by S3")
  .version(VERSION)
  .option("--org <orgId>", "Override org context")
  .option("--drive <driveId>", "Override drive context")
  .option("--json", "Output raw JSON");

const client = new ApiClient();

// Resolve the default org ID via the API
async function getOrgId(): Promise<string> {
  const orgId = program.opts().org;
  if (orgId) return orgId;

  // Check local config override (set by `org switch`)
  const config = getConfig();
  if (config.defaultOrg) return config.defaultOrg;

  try {
    const me = await client.getMe();
    if (me.defaultOrgId) return me.defaultOrgId;
  } catch (err: any) {
    if (err?.message?.includes("Cannot connect")) {
      console.error(err.message);
      process.exit(1);
    }
  }

  console.error("Error: No org context. Use --org or run 'agent-fs auth register'");
  process.exit(1);
}

// Register commands — docs first so it appears at top of --help
program.addCommand(docsCommand());
registerOpCommands(program, client, getOrgId);
program.addCommand(authCommands(client));
program.addCommand(daemonCommands());
program.addCommand(configCommands());
program.addCommand(driveCommands(client, getOrgId));
program.addCommand(orgCommands(client));
program.addCommand(initCommand());
program.addCommand(onboardCommand());
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
