import { expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import { watchCommand } from "../commands/watch.js";

test("watch parses chunked events as JSON and ignores heartbeats", async () => {
  const ready = { driveId: "drive", at: "2026-09-30T12:00:00.000Z" };
  const change = {
    type: "file.changed", driveId: "drive", path: "/café.md", version: 1,
    operation: "write", actor: "user", at: ready.at,
  };
  const data = new TextEncoder().encode(
    `event: ready\ndata: ${JSON.stringify(ready)}\n\n: ping\n\nevent: file.changed\ndata: ${JSON.stringify(change)}\n\n`
  );
  const split = data.indexOf(0xc3) + 1;
  let signal: AbortSignal | undefined;
  const client = {
    getEvents: async (orgId: string, driveId: string, abortSignal: AbortSignal) => {
      expect(orgId).toBe("org");
      expect(driveId).toBe("drive");
      signal = abortSignal;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(data.slice(0, split));
          controller.enqueue(data.slice(split));
          controller.close();
        },
      }));
    },
  } as ApiClient;
  const program = new Command().option("--json");
  program.addCommand(watchCommand(program, client, () => "org", (orgId) => {
    expect(orgId).toBe("org");
    return "drive";
  }));
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const sigintCount = process.listenerCount("SIGINT");
  const sigtermCount = process.listenerCount("SIGTERM");
  try {
    await program.parseAsync(["watch", "--json"], { from: "user" });
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { type: "ready", ...ready }, change,
    ]);
    expect(signal?.aborted).toBe(true);
    expect(error).toHaveBeenCalledWith("Error: event stream closed");
    expect(process.exitCode).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(sigintCount);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermCount);
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = 0;
  }
});
