import { Command } from "commander";
import { parseInviteToken } from "@/core";
import type { ApiClient } from "../api-client.js";

/** Accept an org invite sent as a link, for people who use the CLI only. */
export function inviteCommands(client: ApiClient) {
  const cmd = new Command("invite").description("Org invites you received");

  cmd
    .command("accept")
    .argument("<token-or-url>", "The accept link, or just its token")
    .description("Accept an org invite as the signed-in account")
    .addHelpText(
      "after",
      "\nThe signed-in account's email must be the invited email. Register it first if needed:" +
        "\n  agent-fs auth register <email>\n\nExample:\n  agent-fs invite accept https://live.agent-fs.dev/invite/<token>"
    )
    .action(async (input: string) => {
      const json = cmd.parent?.opts().json;
      try {
        const token = parseInviteToken(input);
        if (!token) {
          throw new Error("That is not an invite link or token. Paste the full link you were sent.");
        }
        const result = await client.post(`/invites/${token}/accept`, {});
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const [org, { drives }] = await Promise.all([
          client.get(`/orgs/${result.orgId}`),
          client.get(`/orgs/${result.orgId}/drives`),
        ]);
        const names = new Map<string, string>(drives.map((d: { id: string; name: string }) => [d.id, d.name]));
        console.log(`Joined org ${org.name} (${result.orgId}) as ${result.role}`);
        for (const d of result.drives as Array<{ driveId: string; role: string }>) {
          console.log(`  drive ${names.get(d.driveId) ?? d.driveId} (${d.driveId})  [${d.role}]`);
        }
        if (result.skippedDrives?.length) {
          console.log(`  ${result.skippedDrives.length} invited drive(s) no longer exist and were skipped`);
        }
        console.log(`Switch to it with: agent-fs org switch ${result.orgId}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}
