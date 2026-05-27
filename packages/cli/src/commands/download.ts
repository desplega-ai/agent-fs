import { Command } from "commander";
import type { ApiClient } from "../api-client.js";

export function downloadCommand(
  client: ApiClient,
  getOrgId: () => string | Promise<string>,
  getDriveId: (orgId?: string) => string | Promise<string>
) {
  const cmd = new Command("download")
    .description("Download raw file bytes to stdout or a local file")
    .argument("<path>", "agent-fs file path")
    .option("-o, --output <file>", "Write to a local file instead of stdout")
    .action(async (path: string, opts: { output?: string }) => {
      try {
        const orgId = await getOrgId();
        const driveId = await getDriveId(orgId);
        const result = await client.getRaw(orgId, driveId, path);

        if (opts.output) {
          await Bun.write(opts.output, result.bytes);
          const json = cmd.parent?.opts().json;
          if (json) {
            console.log(
              JSON.stringify(
                {
                  path,
                  output: opts.output,
                  size: result.bytes.byteLength,
                  contentType: result.contentType,
                  version: result.version,
                  contentHash: result.contentHash,
                },
                null,
                2
              )
            );
          } else {
            console.log(`wrote ${opts.output} (${result.bytes.byteLength} bytes)`);
          }
          return;
        }

        process.stdout.write(Buffer.from(result.bytes));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
  return cmd;
}
