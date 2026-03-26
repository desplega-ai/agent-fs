import { Command } from "commander";
import type { ApiClient } from "../api-client.js";

export function memberCommands(
  client: ApiClient,
  getOrgId: () => string | Promise<string>
) {
  const cmd = new Command("member").description(
    "Member management (use global --drive to scope to a drive)"
  );

  cmd
    .command("list")
    .description("List members of an org (or drive if --drive is set)")
    .action(async () => {
      const json = cmd.parent?.opts().json;
      const driveId = cmd.parent?.opts().drive;
      try {
        const orgId = await getOrgId();
        const path = driveId
          ? `/orgs/${orgId}/drives/${driveId}/members`
          : `/orgs/${orgId}/members`;
        const { members } = await client.get(path);
        if (json) {
          console.log(JSON.stringify(members, null, 2));
          return;
        }
        if (!members || members.length === 0) {
          console.log("(no members)");
          return;
        }
        for (const m of members) {
          console.log(`${m.email}  [${m.role}]`);
        }
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
        const orgId = await getOrgId();
        await client.post(`/orgs/${orgId}/members/invite`, {
          email,
          role: opts.role,
        });
        console.log(`Invited ${email} as ${opts.role}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("update-role")
    .argument("<email>", "User email")
    .requiredOption("--role <role>", "New role: viewer, editor, or admin")
    .description("Update a member's role (use global --drive for drive scope)")
    .action(async (email: string, opts: { role: string }) => {
      const driveId = cmd.parent?.opts().drive;
      try {
        const orgId = await getOrgId();
        const userId = await resolveUserId(client, orgId, email, driveId);
        if (driveId) {
          await client.patch(
            `/orgs/${orgId}/drives/${driveId}/members/${userId}`,
            { role: opts.role }
          );
        } else {
          await client.patch(`/orgs/${orgId}/members/${userId}`, {
            role: opts.role,
          });
        }
        const scope = driveId ? `drive ${driveId}` : "org";
        console.log(`Updated ${email} to ${opts.role} (${scope})`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("remove")
    .argument("<email>", "User email to remove")
    .description("Remove a member from org (or drive only if --drive is set)")
    .action(async (email: string) => {
      const driveId = cmd.parent?.opts().drive;
      try {
        const orgId = await getOrgId();
        const userId = await resolveUserId(client, orgId, email, driveId);
        if (driveId) {
          await client.del(
            `/orgs/${orgId}/drives/${driveId}/members/${userId}`
          );
          console.log(`Removed ${email} from drive ${driveId}`);
        } else {
          await client.del(`/orgs/${orgId}/members/${userId}`);
          console.log(`Removed ${email} from org`);
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}

async function resolveUserId(
  client: ApiClient,
  orgId: string,
  email: string,
  driveId?: string
): Promise<string> {
  const path = driveId
    ? `/orgs/${orgId}/drives/${driveId}/members`
    : `/orgs/${orgId}/members`;
  const { members } = await client.get(path);
  const member = members.find((m: any) => m.email === email);
  if (!member) {
    throw new Error(`Member with email ${email} not found`);
  }
  return member.userId;
}
