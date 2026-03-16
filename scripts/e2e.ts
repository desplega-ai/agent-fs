#!/usr/bin/env bun
/**
 * E2E test script for the agent-fs CLI.
 *
 * Usage:
 *   bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"
 *   bun run scripts/e2e.ts "./packages/cli/dist/cli.js"
 *   bun run scripts/e2e.ts "agent-fs"
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// CLI arg
// ---------------------------------------------------------------------------

const cmd = process.argv[2];
if (!cmd) {
  console.error("Usage: bun run scripts/e2e.ts <cli-command>");
  console.error('  e.g. bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const containerName = `agent-fs-e2e-${process.pid}-${Date.now()}`;
const testDir = join(tmpdir(), containerName);
let minioPort = "";
let passed = 0;
let failed = 0;
const failures: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(args: string): string {
  return execSync(`${cmd} ${args}`, {
    encoding: "utf-8",
    env: { ...process.env, AGENT_FS_HOME: testDir },
    timeout: 30_000,
  }).trim();
}

function runJson(args: string): any {
  return JSON.parse(run(`--json ${args}`));
}

function assert(actual: any, expected: any, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(msg ?? `Expected output to include ${JSON.stringify(needle)}, got ${JSON.stringify(haystack)}`);
  }
}

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    const msg = e.message?.split("\n")[0] ?? String(e);
    console.log(`  ✗ ${name}`);
    console.log(`    ${msg}`);
    failures.push(name);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setup() {
  // Create temp AGENT_FS_HOME
  mkdirSync(testDir, { recursive: true });

  // Start MinIO container on a random port
  execSync(
    `docker run -d --name ${containerName} ` +
      `-p 0:9000 ` +
      `-e MINIO_ROOT_USER=minioadmin ` +
      `-e MINIO_ROOT_PASSWORD=minioadmin ` +
      `minio/minio server /data`,
    { stdio: "pipe" },
  );

  // Get the assigned port
  const portLine = execSync(`docker port ${containerName} 9000`, {
    encoding: "utf-8",
  }).trim();
  // Format: "0.0.0.0:XXXXX" or ":::XXXXX" — take the last port
  minioPort = portLine.split("\n")[0].split(":").pop()!;

  // Wait for MinIO to be healthy
  const start = Date.now();
  const timeoutMs = 15_000;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${minioPort}/minio/health/live`);
      if (res.ok) break;
    } catch {}
    await Bun.sleep(500);
  }
  // Final check
  const health = await fetch(`http://localhost:${minioPort}/minio/health/live`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`MinIO failed to start within ${timeoutMs}ms`);
  }

  // Create bucket with versioning enabled (required for diff/revert)
  execSync(
    `docker exec ${containerName} mc alias set local http://localhost:9000 minioadmin minioadmin && ` +
      `docker exec ${containerName} mc mb local/agentfs && ` +
      `docker exec ${containerName} mc version enable local/agentfs`,
    { stdio: "pipe" },
  );

  // Write config.json
  writeFileSync(
    join(testDir, "config.json"),
    JSON.stringify(
      {
        s3: {
          provider: "minio",
          bucket: "agentfs",
          region: "us-east-1",
          endpoint: `http://localhost:${minioPort}`,
          accessKeyId: "minioadmin",
          secretAccessKey: "minioadmin",
        },
        embedding: { provider: "local", model: "", apiKey: "" },
        server: { port: 7433, host: "127.0.0.1" },
        auth: { apiKey: "" },
        minio: { containerId: "", managed: false },
      },
      null,
      2,
    ),
  );
}

function cleanup() {
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
  } catch {}
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

function runTests() {
  console.log(`\nagent-fs E2E Tests`);
  console.log(`Using: ${cmd}`);
  console.log(`MinIO: localhost:${minioPort} (container: ${containerName})\n`);

  // -- Basics --

  test("--help", () => {
    const out = run("--help");
    assertIncludes(out, "agent-fs");
  });

  test("--version", () => {
    const out = run("--version");
    assert(/^\d+\.\d+\.\d+$/.test(out), true, `Expected semver, got ${JSON.stringify(out)}`);
  });

  // -- write + cat roundtrip --

  test("write + cat roundtrip", () => {
    const result = runJson('write /hello.txt --content "Hello, agent-fs!"');
    assert(result.version, 1);
    const cat = runJson("cat /hello.txt");
    assert(cat.content, "Hello, agent-fs!");
  });

  // -- ls --

  test("ls", () => {
    const result = runJson("ls /");
    const names = result.entries.map((e: any) => e.name);
    assert(names.includes("hello.txt"), true, `Expected hello.txt in ls, got ${JSON.stringify(names)}`);
  });

  // -- append --

  test("append + cat", () => {
    runJson('append /hello.txt --content " Appended."');
    const cat = runJson("cat /hello.txt");
    assert(cat.content, "Hello, agent-fs! Appended.");
  });

  // -- edit --

  test("edit + cat", () => {
    runJson('edit /hello.txt --old "Appended." --new "Edited!"');
    const cat = runJson("cat /hello.txt");
    assert(cat.content, "Hello, agent-fs! Edited!");
  });

  // -- stat --

  test("stat", () => {
    const result = runJson("stat /hello.txt");
    assert(result.path, "/hello.txt");
    assert(typeof result.size, "number");
    assert(result.currentVersion >= 3, true, `Expected version >= 3, got ${result.currentVersion}`);
  });

  // -- tail --

  test("tail", () => {
    // Write a multi-line file
    runJson('write /multiline.txt --content "line1\nline2\nline3\nline4\nline5"');
    const result = runJson("tail /multiline.txt -n 2");
    assert(result.content, "line4\nline5");
  });

  // -- cp --

  test("cp + cat", () => {
    runJson("cp /hello.txt /hello-copy.txt");
    const cat = runJson("cat /hello-copy.txt");
    assert(cat.content, "Hello, agent-fs! Edited!");
  });

  // -- mv --

  test("mv + cat + ls", () => {
    runJson("mv /hello-copy.txt /hello-moved.txt");
    const cat = runJson("cat /hello-moved.txt");
    assert(cat.content, "Hello, agent-fs! Edited!");
    const ls = runJson("ls /");
    const names = ls.entries.map((e: any) => e.name);
    assert(names.includes("hello-copy.txt"), false, "hello-copy.txt should be gone after mv");
    assert(names.includes("hello-moved.txt"), true, "hello-moved.txt should exist after mv");
  });

  // -- log --

  test("log (version history)", () => {
    const result = runJson("log /hello.txt");
    assert(result.versions.length >= 3, true, `Expected >= 3 versions, got ${result.versions.length}`);
  });

  // -- tree --

  test("tree", () => {
    // Create a nested file
    runJson('write /docs/readme.md --content "readme"');
    const result = runJson("tree /");
    const tree = result.tree;
    assert(Array.isArray(tree), true);
    const names = tree.map((e: any) => e.name);
    assert(names.includes("docs"), true, `Expected docs dir in tree, got ${JSON.stringify(names)}`);
  });

  // -- glob --

  test("glob", () => {
    const result = runJson("glob '*.txt'");
    const paths = result.matches.map((m: any) => m.path);
    assert(paths.includes("/hello.txt"), true, `Expected /hello.txt in glob, got ${JSON.stringify(paths)}`);
  });

  // -- reindex (must run before grep/fts to populate FTS index) --

  test("reindex", () => {
    const result = runJson("reindex");
    assert(typeof result.reindexed, "number");
  });

  // -- grep --

  test("grep", () => {
    // grep's path is a directory prefix, not a file path
    const result = runJson("grep Hello /");
    assert(result.matches.length > 0, true, "Expected grep matches");
  });

  // -- fts --

  test("fts", () => {
    // Use a simple token — hyphens are FTS5 NOT operators
    const result = runJson("fts Hello");
    assert(result.matches.length > 0, true, "Expected fts matches");
  });

  // -- comments --

  test("comment add + list + resolve", () => {
    const add = JSON.parse(run('comment add /hello.txt --body "Nice file!"'));
    assert(typeof add.id, "string");

    const list = JSON.parse(run("comment list /hello.txt"));
    assert(list.comments.length >= 1, true, "Expected at least 1 comment");

    const resolve = JSON.parse(run(`comment resolve ${add.id}`));
    assert(resolve.resolved, true, "Expected comment to be resolved");
  });

  // -- recent --

  test("recent", () => {
    const result = runJson("recent");
    assert(result.entries.length > 0, true, "Expected recent entries");
  });

  // -- diff --

  test("diff (between versions)", () => {
    const result = runJson("diff /hello.txt --v1 1 --v2 2");
    assert(Array.isArray(result.changes), true);
    assert(result.changes.length > 0, true, "Expected diff changes between v1 and v2");
  });

  // -- revert --

  test("revert + cat", () => {
    const revert = runJson("revert /hello.txt --to 1");
    assert(revert.revertedTo, 1);
    const cat = runJson("cat /hello.txt");
    assert(cat.content, "Hello, agent-fs!");
  });

  // -- rm --

  test("rm + ls", () => {
    runJson("rm /hello-moved.txt");
    const ls = runJson("ls /");
    const names = ls.entries.map((e: any) => e.name);
    assert(names.includes("hello-moved.txt"), false, "hello-moved.txt should be gone after rm");
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  await setup();
  runTests();
} finally {
  cleanup();
}

console.log(`\nResults: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  console.log(`Failed: ${failures.join(", ")}`);
  process.exit(1);
}
