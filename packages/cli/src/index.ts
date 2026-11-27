#!/usr/bin/env bun
import { Command } from "commander";
import { VERSION, getConfig } from "@/core";
import { ApiClient } from "./api-client.js";
import { registerOpCommands } from "./commands/ops.js";
import { profileCommands } from "./commands/profile.js";
import { authCommands } from "./commands/auth.js";
import { daemonCommands } from "./commands/daemon.js";
import { configCommands } from "./commands/config-cmd.js";
import { driveCommands } from "./commands/drive.js";
import { orgCommands } from "./commands/org.js";
import { initCommand } from "./commands/init.js";
import { onboardCommand } from "./commands/onboard.js";
import { commentCommands } from "./commands/comment.js";
import { webhookCommands } from "./commands/webhook.js";
import { memberCommands } from "./commands/member.js";
import { inviteCommands } from "./commands/invite.js";
import { membersCommand } from "./commands/members.js";
import { docsCommand } from "./commands/docs.js";
import { mountCommand, openCommand, umountCommand } from "./commands/mount.js";
import { downloadCommand } from "./commands/download.js";
import { sqlCommand } from "./commands/sql.js";
import { watchCommand } from "./commands/watch.js";
import { updateCommand } from "./commands/update.js";
import { shieldDashTokens } from "./lib/dash-tokens.js";
import { resolveContextFlags } from "./lib/context-flags.js";

const program = new Command();

program
  .name("agent-fs")
  .description("Agent-first filesystem backed by S3")
  .version(VERSION)
  .option("--org <id-or-name>", "Override org context")
  .option("--drive <id-or-name>", "Override drive context (finds its org when --org is absent)")
  .option("--json", "Output raw JSON");

const client = new ApiClient();

// Resolve the default org ID via the API
//
// Precedence: --org flag > local config (`org switch`, an explicit choice
// persisted on this machine) > AGENT_FS_DEFAULT_ORG_ID (a deployment-level
// hint, e.g. the agent-swarm shared org set on every worker container) >
// the account's own defaultOrgId from GET /me, which is the auto-created
// personal org unless the user has changed it. Without the env tier, every
// call with no flag and no local override silently lands on the personal
// org/drive even when the environment is pointing at a shared one.
async function getOrgId(): Promise<string> {
  const orgId = program.opts().org;
  if (orgId) return orgId;

  const fallback = await defaultOrgId();
  if (fallback) {
    if (fallback.fromAccount) warnIfSharedOrgAvailable(fallback.id);
    return fallback.id;
  }

  console.error("Error: No org context. Use --org or run 'agent-fs auth register'");
  process.exit(1);
}

// The org used when --org is absent: local config, then the env var, then
// the account's default. `strict` reports a failed account lookup instead of
// treating it as "no default".
async function defaultOrgId(strict = false): Promise<{ id: string; fromAccount: boolean } | null> {
  // Check local config override (set by `org switch`)
  const config = getConfig();
  if (config.defaultOrg) return { id: config.defaultOrg, fromAccount: false };

  if (process.env.AGENT_FS_DEFAULT_ORG_ID) {
    return { id: process.env.AGENT_FS_DEFAULT_ORG_ID, fromAccount: false };
  }

  try {
    const me = await client.getMe();
    if (me.defaultOrgId) return { id: me.defaultOrgId, fromAccount: true };
  } catch (err: any) {
    if (strict) throw err;
    if (err?.message?.includes("Cannot connect")) {
      console.error(err.message);
      process.exit(1);
    }
  }
  return null;
}

// AGENT_FS_DEFAULT_ORG_ID already covers the common case above. This covers
// the narrower case where only AGENT_FS_SHARED_ORG_ID is set (agent-swarm
// sets both, but they're independent knobs) — falling back to the personal
// org while a shared one is known and unused is worth a loud warning rather
// than a silent surprise the next time someone can't find their file.
function warnIfSharedOrgAvailable(resolvedOrgId: string): void {
  const sharedOrgId = process.env.AGENT_FS_SHARED_ORG_ID;
  if (sharedOrgId && sharedOrgId !== resolvedOrgId) {
    console.error(
      `Warning: using personal org ${resolvedOrgId}, but AGENT_FS_SHARED_ORG_ID=${sharedOrgId} is set. ` +
        `Pass --org ${sharedOrgId} or run 'agent-fs org switch ${sharedOrgId}' if you meant to write to the shared org.`
    );
  }
}

async function getDriveId(orgId?: string): Promise<string> {
  const driveId = program.opts().drive;
  if (driveId) return driveId;

  const config = getConfig();
  if (config.defaultDrive) return config.defaultDrive;

  if (process.env.AGENT_FS_DEFAULT_DRIVE_ID) return process.env.AGENT_FS_DEFAULT_DRIVE_ID;

  const resolvedOrgId = orgId ?? (await getOrgId());
  const me = await client.getMe();
  if (me.defaultOrgId === resolvedOrgId && me.defaultDriveId) {
    return me.defaultDriveId;
  }

  const { drives } = await client.get(`/orgs/${resolvedOrgId}/drives`);
  const drive = drives.find((d: any) => d.isDefault) ?? drives[0];
  if (!drive) {
    console.error("Error: No drive context. Use --drive or run 'agent-fs drive create'.");
    process.exit(1);
  }
  return drive.id;
}

// Commands that take no org or drive context. They must keep working with
// the API offline, so the flags are left alone for them.
const LOCAL_COMMANDS = new Set([
  "docs", "auth", "profile", "daemon", "config", "org", "init", "onboard",
  "invite", "umount", "open", "update", "mcp", "server",
  "mount status", "drive current", "drive switch",
]);

function isLocalCommand(command: Command): boolean {
  const names: string[] = [];
  for (let c: Command | null = command; c && c !== program; c = c.parent) names.unshift(c.name());
  if (names.join(" ") === "mount" && command.opts().uninstall) return true;
  return LOCAL_COMMANDS.has(names[0]) || LOCAL_COMMANDS.has(names.join(" "));
}

// --org and --drive take an id or a name. Turn them into ids once, before
// the command runs, so every command keeps reading ids from the options.
program.hook("preAction", async (_program, actionCommand) => {
  const { org, drive } = program.opts();
  if (!org && !drive) return;
  if (isLocalCommand(actionCommand)) return;
  try {
    const resolved = await resolveContextFlags(
      { org, drive },
      { get: (path) => client.get(path), defaultOrgId: async () => (await defaultOrgId(true))?.id ?? null }
    );
    if (resolved.org) program.setOptionValue("org", resolved.org);
    if (resolved.drive) program.setOptionValue("drive", resolved.drive);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
});

// Register commands — docs first so it appears at top of --help
program.addCommand(docsCommand());
registerOpCommands(program, client, getOrgId, getDriveId);
program.addCommand(downloadCommand(client, getOrgId, getDriveId));
program.addCommand(sqlCommand(program, client, getOrgId));
program.addCommand(authCommands(client));
program.addCommand(profileCommands(client));
program.addCommand(daemonCommands());
program.addCommand(configCommands());
program.addCommand(driveCommands(client, getOrgId, getDriveId));
program.addCommand(orgCommands(client));
program.addCommand(initCommand());
program.addCommand(onboardCommand());
program.addCommand(commentCommands(client, getOrgId, getDriveId));
program.addCommand(webhookCommands(program, client, getOrgId, getDriveId));
program.addCommand(membersCommand(program, client, getOrgId, getDriveId));
program.addCommand(watchCommand(program, client, getOrgId, getDriveId));
program.addCommand(memberCommands(client, getOrgId));
program.addCommand(inviteCommands(client));
program.addCommand(mountCommand(client, getOrgId, getDriveId));
program.addCommand(umountCommand());
program.addCommand(openCommand());
program.addCommand(updateCommand());

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
  --org <id-or-name>    Override org context
  --drive <id-or-name>  Override drive context (finds its org when --org is absent)
  --json           Output raw JSON
`;
for (const cmd of program.commands) {
  cmd.addHelpText("after", globalHelp);
}

// A token starting with "-" (invite accept, share-revoke --token) must reach
// its command as a value, not be parsed as an option.
program.parse([...process.argv.slice(0, 2), ...shieldDashTokens(program, process.argv.slice(2))]);
