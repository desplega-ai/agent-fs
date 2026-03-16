import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import { getOpDefinition } from "@/core";
import { outputResult } from "../formatters.js";

interface OpCommandDef {
  name: string;
  args: Array<{ name: string; required: boolean }>;
  options: Array<{ flag: string; description: string }>;
}

const OP_COMMANDS: OpCommandDef[] = [
  { name: "write", args: [{ name: "path", required: true }], options: [{ flag: "--content <text>", description: "File content (reads stdin if omitted)" }, { flag: "-m, --message <msg>", description: "Version message" }, { flag: "--expected-version <n>", description: "Fail if file is not at this version (optimistic concurrency)" }] },
  { name: "cat", args: [{ name: "path", required: true }], options: [{ flag: "--offset <n>", description: "Line offset" }, { flag: "--limit <n>", description: "Max lines" }] },
  { name: "edit", args: [{ name: "path", required: true }], options: [{ flag: "--old <string>", description: "Text to replace" }, { flag: "--new <string>", description: "Replacement text" }, { flag: "-m, --message <msg>", description: "Version message" }] },
  { name: "append", args: [{ name: "path", required: true }], options: [{ flag: "--content <text>", description: "Content to append" }, { flag: "-m, --message <msg>", description: "Version message" }] },
  { name: "ls", args: [{ name: "path", required: false }], options: [] },
  { name: "stat", args: [{ name: "path", required: true }], options: [] },
  { name: "rm", args: [{ name: "path", required: true }], options: [] },
  { name: "mv", args: [{ name: "from", required: true }, { name: "to", required: true }], options: [{ flag: "-m, --message <msg>", description: "Version message" }] },
  { name: "cp", args: [{ name: "from", required: true }, { name: "to", required: true }], options: [] },
  { name: "tail", args: [{ name: "path", required: true }], options: [{ flag: "-n, --lines <n>", description: "Number of lines (default: 20)" }] },
  { name: "log", args: [{ name: "path", required: true }], options: [{ flag: "--limit <n>", description: "Max entries" }] },
  { name: "diff", args: [{ name: "path", required: true }], options: [{ flag: "--v1 <n>", description: "First version" }, { flag: "--v2 <n>", description: "Second version" }] },
  { name: "revert", args: [{ name: "path", required: true }], options: [{ flag: "--to <n>", description: "Version to revert to" }] },
  { name: "recent", args: [{ name: "path", required: false }], options: [{ flag: "--since <duration>", description: "Time filter (e.g., 1h, 24h)" }, { flag: "--limit <n>", description: "Max entries" }] },
  { name: "grep", args: [{ name: "pattern", required: true }, { name: "path", required: true }], options: [] },
  { name: "fts", args: [{ name: "pattern", required: true }], options: [{ flag: "--path <prefix>", description: "Path prefix filter" }] },
  { name: "search", args: [{ name: "query", required: true }], options: [{ flag: "--limit <n>", description: "Max results" }] },
  { name: "reindex", args: [], options: [{ flag: "--path <prefix>", description: "Path prefix filter" }] },
  { name: "tree", args: [{ name: "path", required: false }], options: [{ flag: "--depth <n>", description: "Max recursion depth" }] },
  { name: "glob", args: [{ name: "pattern", required: true }], options: [{ flag: "--path <prefix>", description: "Path prefix filter" }] },
];

export function registerOpCommands(
  program: Command,
  client: ApiClient,
  getOrgId: () => string | Promise<string>
) {
  for (const def of OP_COMMANDS) {
    const opDef = getOpDefinition(def.name);
    const cmd = new Command(def.name).description(opDef?.description ?? def.name);

    for (const arg of def.args) {
      if (arg.required) {
        cmd.argument(`<${arg.name}>`);
      } else {
        cmd.argument(`[${arg.name}]`);
      }
    }

    for (const opt of def.options) {
      cmd.option(opt.flag, opt.description);
    }

    cmd.action(async (...actionArgs: any[]) => {
      const opts = actionArgs[actionArgs.length - 2];
      const params: Record<string, any> = { ...opts };

      // Map positional args
      for (let i = 0; i < def.args.length; i++) {
        if (actionArgs[i] !== undefined) {
          params[def.args[i].name] = actionArgs[i];
        }
      }

      // Handle stdin for write/append
      if ((def.name === "write" || def.name === "append") && !params.content) {
        if (!process.stdin.isTTY) {
          params.content = await Bun.stdin.text();
        } else {
          console.error("Error: --content required (or pipe content via stdin)");
          process.exit(1);
        }
      }

      // Map CLI flag names to Zod schema field names
      if (params["expected-version"] !== undefined) {
        params.expectedVersion = params["expected-version"];
        delete params["expected-version"];
      }
      if (params["old"] !== undefined) {
        params.old_string = params["old"];
        delete params["old"];
      }
      if (params["new"] !== undefined) {
        params.new_string = params["new"];
        delete params["new"];
      }
      if (def.name === "revert" && params["to"] !== undefined) {
        params.version = params["to"];
        delete params["to"];
      }

      for (const key of ["offset", "limit", "lines", "v1", "v2", "version", "expectedVersion", "depth"]) {
        if (params[key] !== undefined) {
          params[key] = parseInt(params[key]);
        }
      }

      try {
        const result = await client.callOp(await getOrgId(), def.name, params);
        outputResult(def.name, result, program.opts().json);
      } catch (err: any) {
        if (err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("fetch failed")) {
          console.error(
            "Cannot connect to agent-fs daemon.\n" +
            "Start with: agent-fs daemon start\n" +
            "Or set AGENT_FS_API_URL to connect to a remote server."
          );
          process.exit(1);
        }
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

    program.addCommand(cmd);
  }
}
