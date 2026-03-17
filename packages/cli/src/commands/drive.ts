import { Command } from "commander";
import { setConfigValue, getConfig } from "@/core";
import type { ApiClient } from "../api-client.js";

export function driveCommands(
  client: ApiClient,
  getOrgId: () => string | Promise<string>
) {
  const cmd = new Command("drive").description("Drive management");

  cmd
    .command("list")
    .description("List drives (all orgs unless --org is set)")
    .action(async () => {
      const json = cmd.parent?.opts().json;
      try {
        // If --org is explicitly passed, list only that org's drives
        const explicitOrg = cmd.parent?.opts().org;
        if (explicitOrg) {
          const result = await client.get(`/orgs/${explicitOrg}/drives`);
          if (json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          for (const d of result.drives) {
            const flags = d.isDefault ? "  (default)" : "";
            console.log(`${d.id}  ${d.name}${flags}`);
          }
          return;
        }

        // Otherwise, list drives across all orgs
        const { orgs } = await client.get("/orgs");
        if (json) {
          const allDrives: any[] = [];
          for (const org of orgs) {
            const { drives } = await client.get(`/orgs/${org.id}/drives`);
            allDrives.push({ orgId: org.id, orgName: org.name, drives });
          }
          console.log(JSON.stringify(allDrives, null, 2));
          return;
        }
        if (!orgs || orgs.length === 0) {
          console.log("(no orgs)");
          return;
        }
        const config = getConfig();
        for (const org of orgs) {
          const orgFlags: string[] = [];
          if (org.isPersonal) orgFlags.push("personal");
          if (config.defaultOrg === org.id) orgFlags.push("active");
          const orgSuffix = orgFlags.length > 0 ? `  (${orgFlags.join(", ")})` : "";
          console.log(`\n${org.name} [${org.role}]${orgSuffix}`);

          const { drives } = await client.get(`/orgs/${org.id}/drives`);
          for (const d of drives) {
            const flags: string[] = [];
            if (d.isDefault) flags.push("default");
            if (config.defaultDrive === d.id) flags.push("active");
            const suffix = flags.length > 0 ? `  (${flags.join(", ")})` : "";
            console.log(`  ${d.id}  ${d.name}${suffix}`);
          }
        }
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
        const orgId = await getOrgId();
        const result = await client.post(`/orgs/${orgId}/drives`, { name });
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("current")
    .description("Show current drive context")
    .action(async () => {
      const json = cmd.parent?.opts().json;
      try {
        const config = getConfig();
        const me = await client.getMe();
        const orgId = config.defaultOrg ?? me.defaultOrgId;
        if (!orgId) {
          console.error("Error: No org context. Run 'agent-fs auth register' first.");
          process.exit(1);
        }
        const { drives } = await client.get(`/orgs/${orgId}/drives`);
        let drive: any;
        if (config.defaultDrive) {
          drive = drives.find((d: any) => d.id === config.defaultDrive);
        }
        if (!drive) {
          drive = drives.find((d: any) => d.isDefault) ?? drives[0] ?? null;
        }
        const source = config.defaultOrg ? "config (org switch)" : "server default";
        if (json) {
          console.log(JSON.stringify({ orgId, drive, source }, null, 2));
        } else {
          console.log(`org:    ${orgId}`);
          console.log(`drive:  ${drive?.id ?? "(none)"}  ${drive?.name ?? ""}`);
          console.log(`source: ${source}`);
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("switch")
    .argument("<driveId>", "Drive ID to switch to")
    .description("Set default drive context")
    .action(async (driveId: string) => {
      try {
        // We need to find which org this drive belongs to, so list all orgs' drives
        const { orgs } = await client.get("/orgs");
        let found: any = null;
        let foundOrg: any = null;
        for (const org of orgs) {
          const { drives } = await client.get(`/orgs/${org.id}/drives`);
          const match = drives.find((d: any) => d.id === driveId);
          if (match) {
            found = match;
            foundOrg = org;
            break;
          }
        }
        if (!found) {
          console.error(`Error: Drive ${driveId} not found in any of your orgs.`);
          process.exit(1);
        }
        setConfigValue("defaultOrg", foundOrg.id);
        setConfigValue("defaultDrive", driveId);
        console.log(`Switched to drive: ${found.name} (org: ${foundOrg.name})`);
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
    .addHelpText(
      "after",
      "\nThis invites the user to the organization that owns the current drive. The user will have access to all drives in the org based on their role."
    )
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

  return cmd;
}
