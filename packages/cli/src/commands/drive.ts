import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import {
  createDatabase,
  listDrives,
  createDrive,
  getDrive,
  setDriveMember,
  listUserOrgs,
  getUserByApiKey,
  getConfig,
  setConfigValue,
  inviteToOrg,
} from "@agentfs/core";

export function driveCommands(client: ApiClient) {
  const cmd = new Command("drive").description("Drive management");

  cmd
    .command("list")
    .description("List drives in current org")
    .action(async () => {
      try {
        const { db, orgId } = getLocalContext();
        const drives = listDrives(db, orgId);
        console.log(JSON.stringify({ drives }, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("create")
    .argument("<name>", "Drive name")
    .description("Create a new drive")
    .action(async (name: string) => {
      try {
        const { db, orgId } = getLocalContext();
        const drive = createDrive(db, { orgId, name });
        console.log(JSON.stringify(drive, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("current")
    .description("Show current drive context")
    .action(async () => {
      try {
        const { db, orgId, userId } = getLocalContext();
        const drives = listDrives(db, orgId);
        const defaultDrive = drives.find((d) => d.isDefault);
        console.log(
          JSON.stringify(
            { orgId, drive: defaultDrive ?? drives[0] ?? null },
            null,
            2
          )
        );
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("invite")
    .argument("<email>", "User email to invite")
    .requiredOption("--role <role>", "Role: viewer, editor, or admin")
    .description("Invite a user to the current org")
    .action(async (email: string, opts: { role: string }) => {
      try {
        const { db, orgId } = getLocalContext();
        inviteToOrg(db, {
          orgId,
          email,
          role: opts.role as "viewer" | "editor" | "admin",
        });
        console.log(`Invited ${email} as ${opts.role}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}

function getLocalContext() {
  const config = getConfig();
  if (!config.auth.apiKey) {
    throw new Error("Not logged in. Run: agentfs auth register <email>");
  }
  const db = createDatabase();
  const user = getUserByApiKey(db, config.auth.apiKey);
  if (!user) throw new Error("Invalid API key in config.");
  const orgs = listUserOrgs(db, user.id);
  if (orgs.length === 0) throw new Error("No orgs found.");
  return { db, orgId: orgs[0].id, userId: user.id };
}
