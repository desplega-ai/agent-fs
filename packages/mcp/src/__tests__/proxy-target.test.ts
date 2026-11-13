import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Spawns `bun packages/cli/src/index.ts mcp` the way an MCP host would, from a
// project directory, and records which Authorization headers reach a loopback
// listener.
const CLI = resolve(import.meta.dir, "../../../cli/src/index.ts");
const STORED_KEY = "af_" + "0".repeat(64);
const HOST_KEY = "af_" + "1".repeat(64);

let seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let port: number;
let root: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push(req.headers.get("authorization") ?? "");
      return new Response("nope", { status: 500 });
    },
  });
  port = server.port!;
  root = mkdtempSync(join(tmpdir(), "agent-fs-mcp-proxy-"));
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function runProxy(opts: { dotenv?: string; env?: Record<string, string>; apiUrl?: string }) {
  seen = [];
  const dir = mkdtempSync(join(root, "case-"));
  const home = join(dir, "home");
  mkdirSync(home);
  // Stored key from `agent-fs auth register`, plus an optional stored apiUrl.
  writeFileSync(join(home, "config.json"), JSON.stringify({ apiUrl: opts.apiUrl, auth: { apiKey: STORED_KEY } }));
  const project = join(dir, "project");
  mkdirSync(project);
  if (opts.dotenv) writeFileSync(join(project, ".env"), opts.dotenv);

  const proc = Bun.spawn([process.execPath, CLI, "mcp"], {
    cwd: project,
    env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_FS_HOME: home, ...opts.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  await proc.exited;
  clearTimeout(timer);
  return [...seen];
}

describe("stdio MCP proxy target", () => {
  test("host-set URL and key reach the server", async () => {
    const headers = await runProxy({
      env: { AGENT_FS_API_URL: `http://127.0.0.1:${port}`, AGENT_FS_API_KEY: HOST_KEY },
    });
    expect(headers).toContain(`Bearer ${HOST_KEY}`);
  }, 20_000);

  test("stored apiUrl receives the stored key", async () => {
    const headers = await runProxy({ apiUrl: `http://127.0.0.1:${port}` });
    expect(headers).toContain(`Bearer ${STORED_KEY}`);
  }, 20_000);

  test("project .env AGENT_FS_API_URL does not receive the stored key", async () => {
    const headers = await runProxy({ dotenv: `AGENT_FS_API_URL=http://127.0.0.1:${port}\n` });
    expect(headers).not.toContain(`Bearer ${STORED_KEY}`);
  }, 20_000);

  test("project .env PORT does not receive the stored key", async () => {
    const headers = await runProxy({ dotenv: `PORT=${port}\n` });
    expect(headers).not.toContain(`Bearer ${STORED_KEY}`);
  }, 20_000);
});
