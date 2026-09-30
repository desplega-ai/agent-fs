import { Command } from "commander";
import type { ApiClient } from "../api-client.js";

export function watchCommand(
  program: Command,
  client: ApiClient,
  getOrgId: () => string | Promise<string>,
  getDriveId: (orgId?: string) => string | Promise<string>
) {
  return new Command("watch")
    .description("Stream changes for the active drive until Ctrl+C")
    .action(async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const orgId = await getOrgId();
        const driveId = await getDriveId(orgId);
        const response = await client.getEvents(orgId, driveId, controller.signal);
        if (!response.body) throw new Error("Event stream has no response body");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const lines = frame.split("\n");
            const type = lines.find((line) => line.startsWith("event: "))?.slice(7);
            const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
            if (!type || !data) continue;
            const event = { type, ...JSON.parse(data) };
            if (program.opts().json) console.log(JSON.stringify(event));
            else if (type === "ready") console.log(`Watching drive ${event.driveId}`);
            else console.log(`${event.at} ${type} ${event.path} ${event.action ?? event.operation} ${event.actor}`);
          }
        }
      } catch (err: any) {
        if (!controller.signal.aborted) {
          console.error(`Error: ${err.message}`);
          process.exitCode = 1;
        }
      } finally {
        controller.abort();
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
      }
    });
}
