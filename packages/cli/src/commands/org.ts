import { Command } from "commander";
import { setConfigValue, getConfig } from "@/core";
import type { ApiClient } from "../api-client.js";

export function orgCommands(client: ApiClient) {
  const cmd = new Command("org").description("Org management");

  cmd
    .command("list")
    .description("List orgs you belong to")
    .action(async () => {
      const json = cmd.parent?.opts().json;
      try {
        const { orgs } = await client.get("/orgs");
        if (json) {
          console.log(JSON.stringify(orgs, null, 2));
          return;
        }
        if (!orgs || orgs.length === 0) {
          console.log("(no orgs)");
          return;
        }
        const config = getConfig();
        const activeOrgId = config.defaultOrg || process.env.AGENT_FS_DEFAULT_ORG_ID;
        for (const org of orgs) {
          const flags: string[] = [];
          if (org.isPersonal) flags.push("personal");
          if (activeOrgId === org.id) flags.push("active");
          const suffix = flags.length > 0 ? `  (${flags.join(", ")})` : "";
          console.log(`${org.id}  ${org.name}  [${org.role}]${suffix}`);
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("current")
    .description("Show current org context")
    .action(async () => {
      const json = cmd.parent?.opts().json;
      try {
        const config = getConfig();
        const me = await client.getMe();
        const effectiveOrgId =
          config.defaultOrg || process.env.AGENT_FS_DEFAULT_ORG_ID || me.defaultOrgId;
        if (!effectiveOrgId) {
          console.error("Error: No org context. Run 'agent-fs auth register' first.");
          process.exit(1);
        }
        const org = await client.get(`/orgs/${effectiveOrgId}`);
        const source = config.defaultOrg
          ? "config (org switch)"
          : process.env.AGENT_FS_DEFAULT_ORG_ID
            ? "env (AGENT_FS_DEFAULT_ORG_ID)"
            : "server default";
        if (json) {
          console.log(JSON.stringify({ ...org, source }, null, 2));
        } else {
          console.log(`${org.id}  ${org.name}${org.isPersonal ? "  (personal)" : ""}`);
          console.log(`source: ${source}`);
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("switch")
    .argument("<orgId>", "Org ID to switch to")
    .description("Set default org context")
    .action(async (orgId: string) => {
      try {
        // Validate the org exists and user has access
        const org = await client.get(`/orgs/${orgId}`);
        setConfigValue("defaultOrg", orgId);
        // Clear defaultDrive when switching orgs — it belongs to the previous org
        setConfigValue("defaultDrive", undefined);
        console.log(`Switched to org: ${org.name} (${orgId})`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}
