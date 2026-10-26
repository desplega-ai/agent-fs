import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import { setConfigValue } from "@/core";

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
    .requiredOption("--role <role>", "Org role: viewer, editor, or admin")
    .option(
      "--to <drive[:role]>",
      "Grant a drive by id or name, optionally with its own role (repeatable; role defaults to --role)",
      collect
    )
    .description("Invite a user to the current org")
    .addHelpText(
      "after",
      "\nWithout --to, the user gets the org's default drive with --role." +
        "\nWith --to, the user gets exactly the listed drives and nothing else." +
        "\n\nExample:\n  agent-fs member invite ana@example.com --role viewer --to context:editor --to ledger"
    )
    .action(async (email: string, opts: { role: string; to?: string[] }) => {
      const json = cmd.parent?.opts().json;
      try {
        const orgId = await getOrgId();
        let manageable: DriveRef[] = [];
        let grants: Array<{ driveId: string; role: string }> | undefined;
        if (opts.to) {
          await requireDriveInvites(client);
          manageable = await listManageableDrives(client, orgId);
          grants = opts.to.map((spec) => {
            const { ref, role } = parseDriveSpec(spec, opts.role);
            return { driveId: pickDrive(manageable, ref).id, role };
          });
        }
        const result = await inviteMember(client, orgId, email, opts.role, grants);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printInviteResult(email, opts.role, result, manageable);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("add")
    .argument("<email>", "Email of an existing org member")
    .requiredOption("--role <role>", "Drive role: viewer, editor, or admin")
    .description("Add an existing org member to a drive (requires global --drive)")
    .addHelpText(
      "after",
      "\nRequires drive admin on the target drive, or org admin. The person must already be in the org;" +
        "\nuse 'member invite --to' for someone new.\n\nExample:\n  agent-fs --drive ledger member add ana@example.com --role viewer"
    )
    .action(async (email: string, opts: { role: string }) => {
      const json = cmd.parent?.opts().json;
      const driveRef = cmd.parent?.opts().drive;
      try {
        if (!driveRef) {
          throw new Error(
            "member add needs a target drive: pass the global --drive <id-or-name>, e.g. agent-fs --drive ledger member add <email> --role viewer"
          );
        }
        const orgId = await getOrgId();
        const drive = pickDrive(await listManageableDrives(client, orgId), driveRef);
        const result = await client.post(`/orgs/${orgId}/drives/${drive.id}/members`, {
          email,
          role: opts.role,
        });
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const verb = result.created ? "Added" : "Updated";
        console.log(`${verb} ${email} on drive ${drive.name} as ${opts.role}`);
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
        const userId = await resolveUserId(client, orgId, email, driveId).catch((err) => {
          if (!driveId) throw err;
          throw new Error(
            `${email} is not on drive ${driveId}. To grant access, run: agent-fs --drive ${driveId} member add ${email} --role ${opts.role}`
          );
        });
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
    .command("reset-key")
    .argument("<email>", "User email whose key to reset")
    .description("Reset a member's API key (org admin only)")
    .action(async (email: string) => {
      const json = cmd.parent?.opts().json;
      try {
        const orgId = await getOrgId();
        const userId = await resolveUserId(client, orgId, email);
        // An admin can target their own email (e.g. lost their local key but
        // still knows their old one, or is rotating on a schedule). Resolve
        // self-target BEFORE the reset call: the reset invalidates the
        // caller's own current key, so checking identity afterwards with the
        // now-stale key would 401.
        const me = await client.getMe();
        const isSelf = me.userId === userId;
        const result = await client.post(
          `/orgs/${orgId}/members/${userId}/reset-key`,
          {}
        );
        // The server-side reset invalidates the caller's own credential in
        // the self-target case, so persist the fresh key locally the same
        // way `auth reset-key` does — otherwise the admin is locked out by
        // their own successful reset.
        if (isSelf) {
          setConfigValue("auth.apiKey", result.apiKey);
          setConfigValue("apiKey", result.apiKey);
          client.setApiKey(result.apiKey);
        }
        if (json) {
          console.log(
            JSON.stringify(
              { apiKey: result.apiKey, userId: result.userId, email: result.email },
              null,
              2
            )
          );
          return;
        }
        console.log(`New API key for ${email}: ${result.apiKey}`);
        console.log("Give this key to the user on a secure channel. The old key is now invalid.");
        console.log("This key is shown only once and grants full access to the user's account.");
        if (isSelf) {
          console.log("This is your own account — the new key has been saved to your local config.");
        }
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

function collect(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

const ROLES = ["viewer", "editor", "admin"];

/** Parse `<drive>[:<role>]`; the role defaults to the invite's org role. */
export function parseDriveSpec(spec: string, defaultRole: string): { ref: string; role: string } {
  const sep = spec.lastIndexOf(":");
  if (sep <= 0) return { ref: spec, role: defaultRole };
  const role = spec.slice(sep + 1);
  if (!ROLES.includes(role)) {
    throw new Error(`Invalid role "${role}" in --to ${spec}. Use <drive>:viewer, <drive>:editor, or <drive>:admin.`);
  }
  return { ref: spec.slice(0, sep), role };
}

type DriveRef = { id: string; name: string };

export async function listManageableDrives(client: ApiClient, orgId: string): Promise<DriveRef[]> {
  return (await client.get(`/orgs/${orgId}/drives?scope=manageable`)).drives;
}

/**
 * Resolve a drive id or name among the drives the caller can manage.
 * Anything else passes through unchanged as an id, so the server stays the
 * one that answers 403 or 404.
 */
export function pickDrive(drives: DriveRef[], ref: string): DriveRef {
  const byId = drives.find((d) => d.id === ref);
  if (byId) return byId;
  const byName = drives.filter((d) => d.name === ref);
  if (byName.length > 1) {
    throw new Error(`Drive name "${ref}" is ambiguous in this org; use the drive id`);
  }
  return byName[0] ?? { id: ref, name: ref };
}

/** Fail before writing when the server would silently ignore drive grants. */
export async function requireDriveInvites(client: ApiClient): Promise<void> {
  const health = await client.get("/health");
  if (!health.features?.includes("drive-invites")) {
    throw new Error(
      "This server cannot grant specific drives on invite. Upgrade the agent-fs server, or use 'member invite' without --to (default drive only)."
    );
  }
}

export async function inviteMember(
  client: ApiClient,
  orgId: string,
  email: string,
  role: string,
  drives?: Array<{ driveId: string; role: string }>
): Promise<{ drives?: Array<{ driveId: string; role: string }> }> {
  return client.post(`/orgs/${orgId}/members/invite`, {
    email,
    role,
    ...(drives ? { drives } : {}),
  });
}

export function printInviteResult(
  email: string,
  role: string,
  result: { drives?: Array<{ driveId: string; role: string }> },
  drives: DriveRef[]
): void {
  const names = new Map(drives.map((d) => [d.id, d.name]));
  console.log(`Invited ${email} as ${role}`);
  // Servers older than the drive-invites feature return no drive list.
  if (!result.drives) return;
  if (result.drives.length === 0) {
    console.log("  (no drive access granted)");
    return;
  }
  for (const d of result.drives) {
    const name = names.get(d.driveId);
    console.log(`  drive ${name ? `${name} (${d.driveId})` : d.driveId}  [${d.role}]`);
  }
}
