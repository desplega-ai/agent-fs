import { Command } from "commander";
import type { ApiClient } from "../api-client.js";

interface OpCommandDef {
  name: string;
  description: string;
  args: Array<{ name: string; required: boolean }>;
  options: Array<{ flag: string; description: string }>;
}

// Define CLI commands from op definitions
// Deviation: not auto-generated from Zod schemas (would require Zod-to-Commander mapping).
// Instead, manually defined but mirrors the op registry.
const OP_COMMANDS: OpCommandDef[] = [
  { name: "write", description: "Write content to a file", args: [{ name: "path", required: true }], options: [{ flag: "--content <text>", description: "File content (reads stdin if omitted)" }, { flag: "-m, --message <msg>", description: "Version message" }] },
  { name: "cat", description: "Read file content", args: [{ name: "path", required: true }], options: [{ flag: "--offset <n>", description: "Line offset" }, { flag: "--limit <n>", description: "Max lines" }] },
  { name: "edit", description: "Edit file content", args: [{ name: "path", required: true }], options: [{ flag: "--old <string>", description: "Text to replace" }, { flag: "--new <string>", description: "Replacement text" }, { flag: "-m, --message <msg>", description: "Version message" }] },
  { name: "append", description: "Append content to a file", args: [{ name: "path", required: true }], options: [{ flag: "--content <text>", description: "Content to append" }, { flag: "-m, --message <msg>", description: "Version message" }] },
  { name: "ls", description: "List files in a directory", args: [{ name: "path", required: true }], options: [] },
  { name: "stat", description: "Show file metadata", args: [{ name: "path", required: true }], options: [] },
  { name: "rm", description: "Remove a file", args: [{ name: "path", required: true }], options: [] },
  { name: "mv", description: "Move/rename a file", args: [{ name: "from", required: true }, { name: "to", required: true }], options: [{ flag: "-m, --message <msg>", description: "Version message" }] },
  { name: "cp", description: "Copy a file", args: [{ name: "from", required: true }, { name: "to", required: true }], options: [] },
  { name: "head", description: "Show first N lines", args: [{ name: "path", required: true }], options: [{ flag: "-n, --lines <n>", description: "Number of lines (default: 20)" }] },
  { name: "tail", description: "Show last N lines", args: [{ name: "path", required: true }], options: [{ flag: "-n, --lines <n>", description: "Number of lines (default: 20)" }] },
  { name: "mkdir", description: "Create a directory", args: [{ name: "path", required: true }], options: [] },
  { name: "log", description: "Show version history", args: [{ name: "path", required: true }], options: [{ flag: "--limit <n>", description: "Max entries" }] },
  { name: "diff", description: "Show diff between versions", args: [{ name: "path", required: true }], options: [{ flag: "--v1 <n>", description: "First version" }, { flag: "--v2 <n>", description: "Second version" }] },
  { name: "revert", description: "Revert to a previous version", args: [{ name: "path", required: true }], options: [{ flag: "--version <n>", description: "Version to revert to" }] },
  { name: "recent", description: "Show recent activity", args: [{ name: "path", required: false }], options: [{ flag: "--since <duration>", description: "Time filter (e.g., 1h, 24h)" }, { flag: "--limit <n>", description: "Max entries" }] },
  { name: "grep", description: "Search file content with regex", args: [{ name: "pattern", required: true }, { name: "path", required: true }], options: [] },
  { name: "find", description: "Full-text search (FTS5)", args: [{ name: "pattern", required: true }], options: [{ flag: "--path <prefix>", description: "Path prefix filter" }] },
  { name: "search", description: "Semantic search", args: [{ name: "query", required: true }], options: [{ flag: "--limit <n>", description: "Max results" }] },
];

export function registerOpCommands(
  program: Command,
  client: ApiClient,
  getOrgId: () => string
) {
  for (const def of OP_COMMANDS) {
    const cmd = new Command(def.name).description(def.description);

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
      const opts = actionArgs[actionArgs.length - 2]; // Commander puts options as second-to-last
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

      // Convert numeric options
      for (const key of ["offset", "limit", "lines", "v1", "v2", "version"]) {
        if (params[key] !== undefined) {
          params[key] = parseInt(params[key]);
        }
      }

      try {
        const result = await client.callOp(getOrgId(), def.name, params);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

    program.addCommand(cmd);
  }
}
