import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { Command } from "commander";
import type { ApiClient } from "../api-client.js";

/**
 * The local file to write: `target` itself, or the remote file's name inside
 * `target` when that is an existing directory (as `cp` does).
 */
export function resolveDownloadTarget(remotePath: string, target: string): string {
  let isDirectory = false;
  try {
    isDirectory = statSync(target).isDirectory();
  } catch {
    // Not there yet: it is the file to create.
  }
  return isDirectory ? join(target, basename(remotePath)) : target;
}

export function downloadCommand(
  client: ApiClient,
  getOrgId: () => string | Promise<string>,
  getDriveId: (orgId?: string) => string | Promise<string>
) {
  const cmd = new Command("download")
    .description("Download raw file bytes to stdout or a local file")
    .argument("<path>", "agent-fs file path")
    .argument("[target]", "Local file or directory to write to (same as -o)")
    .option("-o, --output <file>", "Write to a local file or directory instead of stdout")
    .action(async (path: string, target: string | undefined, opts: { output?: string }) => {
      try {
        if (target && opts.output) {
          throw new Error("Give the local path once: as the second argument or with -o, not both");
        }
        const requested = target ?? opts.output;
        const output = requested ? resolveDownloadTarget(path, requested) : undefined;
        const orgId = await getOrgId();
        const driveId = await getDriveId(orgId);
        const result = await client.getRaw(orgId, driveId, path);

        if (output) {
          await Bun.write(output, result.bytes);
          const json = cmd.parent?.opts().json;
          if (json) {
            console.log(
              JSON.stringify(
                {
                  path,
                  output,
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
            console.log(`wrote ${output} (${result.bytes.byteLength} bytes)`);
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
