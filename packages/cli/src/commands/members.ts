import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import { outputResult } from "../formatters.js";

export function membersCommand(
  program: Command,
  client: ApiClient,
  getOrgId: () => string | Promise<string>,
  getDriveId: (orgId?: string) => string | Promise<string>
) {
  return new Command("members")
    .description("List members of the active drive")
    .action(async () => {
      try {
        const orgId = await getOrgId();
        const driveId = await getDriveId(orgId);
        const result = await client.callOp(orgId, "drive-members", { driveId });
        outputResult("drive-members", result, program.opts().json);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
