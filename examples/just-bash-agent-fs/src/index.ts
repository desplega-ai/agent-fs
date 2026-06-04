import { Bash } from "just-bash";
import { AgentFsFileSystem } from "@desplega.ai/agent-fs-just-bash";

const baseUrl = process.env.AGENT_FS_API_URL ?? "http://127.0.0.1:7433";
const apiKey = requiredEnv("AGENT_FS_API_KEY");
const orgId = requiredEnv("AGENT_FS_ORG_ID");
const driveId = requiredEnv("AGENT_FS_DRIVE_ID");

const fs = new AgentFsFileSystem({
  baseUrl,
  apiKey,
  orgId,
  driveId,
  writeMessage: (operation, path) =>
    `just-bash example: ${operation} ${path}`,
});

await fs.mkdir("/examples/just-bash", { recursive: true });
await fs.writeFile(
  "/examples/just-bash/readme.txt",
  [
    "Hello from just-bash.",
    "This file was written through the agent-fs filesystem adapter.",
    "",
  ].join("\n"),
);

await fs.refreshAllPaths("/examples");

const bash = new Bash({
  fs,
  cwd: "/examples/just-bash",
});

const result = await bash.exec([
  "printf 'Working directory: '",
  "pwd",
  "printf '\\nFiles:\\n'",
  "ls",
  "printf '\\nContents:\\n'",
  "cat readme.txt",
].join("\n"));

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.exitCode !== 0) process.exitCode = result.exitCode;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. See .env.example.`);
  }
  return value;
}
