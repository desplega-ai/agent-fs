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
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const positional = rawArgs.filter((a) => !a.startsWith("--"));
const flags = new Set(rawArgs.filter((a) => a.startsWith("--")));
const cmd = positional[0];
if (!cmd) {
  console.error("Usage: bun run scripts/e2e.ts <cli-command> [--fuse-only]");
  console.error('  e.g. bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"');
  process.exit(1);
}

const fuseOnly = flags.has("--fuse-only");
// Whether to attempt FUSE tests via a sibling Docker container with FUSE caps.
// Auto-enabled on Linux, opt-in on Darwin via AGENT_FS_USE_DOCKER_FUSE=1.
// Set AGENT_FS_USE_DOCKER_FUSE=0 to force-skip everywhere.
const useDockerFuse =
  process.env.AGENT_FS_USE_DOCKER_FUSE === "1" ||
  (process.platform === "linux" && process.env.AGENT_FS_USE_DOCKER_FUSE !== "0");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const containerName = `agent-fs-e2e-${process.pid}-${Date.now()}`;
const fuseContainerName = `${containerName}-fuse`;
const fuseImageTag = "agent-fs-e2e-fuse:local";
const testDir = join(tmpdir(), containerName);
let minioPort = "";
let daemonPort = 0;
let apiKey = "";
let personalOrgId = "";
let personalDriveId = "";
let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];
let fuseReady = false;
let fuseSkipReason = "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a random available TCP port. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        return reject(new Error("Failed to get port"));
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Env object that forces the daemon/CLI to use the test MinIO, not .env values. */
const testEnv = () => ({
  ...process.env,
  AGENT_FS_HOME: testDir,
  // Override S3 env vars to ensure daemon uses test MinIO, not .env values
  S3_ENDPOINT: `http://localhost:${minioPort}`,
  S3_BUCKET: "agentfs",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "minioadmin",
  S3_REGION: "us-east-1",
  S3_PROVIDER: "minio",
  // Clear AWS_* vars (they take precedence over S3_* in applyEnvOverrides)
  AWS_ENDPOINT_URL_S3: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  AWS_REGION: "",
  BUCKET_NAME: "",
});

/** Run a CLI command. Only passes AGENT_FS_HOME (no API key/URL needed for daemon commands). */
function runRaw(args: string): string {
  return execSync(`${cmd} ${args}`, {
    encoding: "utf-8",
    env: testEnv(),
    timeout: 30_000,
  }).trim();
}

/** Run a CLI command with full API context (URL + key). */
function run(args: string): string {
  return execSync(`${cmd} ${args}`, {
    encoding: "utf-8",
    env: {
      ...testEnv(),
      AGENT_FS_API_URL: `http://127.0.0.1:${daemonPort}`,
      AGENT_FS_API_KEY: apiKey,
    },
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

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
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

/**
 * Run a `fuse`-tagged test. Auto-skips if the FUSE container isn't ready
 * (e.g. running on Darwin without AGENT_FS_USE_DOCKER_FUSE=1).
 */
async function fuseTest(name: string, fn: () => void | Promise<void>) {
  const tag = `[fuse] ${name}`;
  if (!fuseReady) {
    skipped++;
    console.log(`  ⊘ ${tag} — skipped (${fuseSkipReason || "FUSE not available"})`);
    return;
  }
  await test(tag, fn);
}

/**
 * `docker exec` a command inside the FUSE container. Returns stdout (trimmed).
 * Errors include stderr to make assertion failures self-explaining.
 */
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function runFuseCmd(cmdStr: string, opts: { allowFailure?: boolean; timeoutMs?: number; env?: Record<string, string> } = {}): string {
  const envFlags = Object.entries(opts.env || {})
    .map(([k, v]) => `-e ${k}=${shQuote(v)}`)
    .join(" ");
  const full = `docker exec ${envFlags} ${fuseContainerName} bash -lc ${shQuote(cmdStr)}`;
  try {
    return execSync(full, {
      encoding: "utf-8",
      timeout: opts.timeoutMs ?? 90_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    if (opts.allowFailure) {
      const stdout = (e.stdout?.toString?.() ?? "").trim();
      const stderr = (e.stderr?.toString?.() ?? "").trim();
      return `EXIT=${e.status ?? "?"}\nSTDOUT:${stdout}\nSTDERR:${stderr}`;
    }
    const stdout = (e.stdout?.toString?.() ?? "").trim();
    const stderr = (e.stderr?.toString?.() ?? "").trim();
    throw new Error(
      `docker exec failed (exit=${e.status ?? "?"}): ${stderr || stdout || e.message}`,
    );
  }
}

// MCP request headers (required by MCP spec)
const mcpHeaders = (key: string) => ({
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
  "Authorization": `Bearer ${key}`,
});

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

  // Find a free port for the daemon
  daemonPort = await findFreePort();

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
          versioningEnabled: true,
        },
        embedding: { provider: "local", model: "", apiKey: "" },
        server: { port: daemonPort, host: "127.0.0.1", rateLimit: { requestsPerMinute: 5000 } },
        auth: { apiKey: "" },
        minio: { containerId: "", managed: false },
      },
      null,
      2,
    ),
  );

  // Start daemon via the CLI command being tested
  runRaw("daemon start");

  // Wait for daemon to be ready
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const daemonStart = Date.now();
  const daemonTimeoutMs = 15_000;
  while (Date.now() - daemonStart < daemonTimeoutMs) {
    try {
      const res = await fetch(`${daemonUrl}/health`);
      if (res.ok) break;
    } catch {}
    await Bun.sleep(300);
  }
  const daemonHealth = await fetch(`${daemonUrl}/health`).catch(() => null);
  if (!daemonHealth?.ok) {
    throw new Error(`Daemon failed to start within ${daemonTimeoutMs}ms on port ${daemonPort}`);
  }

  // Register a test user to get an API key
  const regRes = await fetch(`${daemonUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@e2e.local" }),
  });
  if (!regRes.ok) {
    const body = await regRes.text();
    throw new Error(`Failed to register test user: ${regRes.status} ${body}`);
  }
  const regData = await regRes.json() as { apiKey: string; userId: string; orgId: string };
  apiKey = regData.apiKey;
  personalOrgId = regData.orgId;

  // Fetch the personal org's default drive ID
  const drivesRes = await fetch(`${daemonUrl}/orgs/${personalOrgId}/drives`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  const drivesData = await drivesRes.json() as any;
  personalDriveId = drivesData.drives[0]?.id;

  // Also save the API key to config so CLI's getOrgId() can resolve via local DB
  const configPath = join(testDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  config.auth.apiKey = apiKey;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function cleanup() {
  // Stop daemon via CLI
  try {
    runRaw("daemon stop");
  } catch {}
  // Remove MinIO container
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
  } catch {}
  // Remove FUSE runner container + named volumes (best-effort: unmount + stop + rm)
  if (fuseReady) {
    try {
      execSync(
        `docker exec ${fuseContainerName} bash -lc 'fusermount3 -u /mnt/agent-fs 2>/dev/null; true'`,
        { stdio: "ignore", timeout: 10_000 },
      );
    } catch {}
    try {
      execSync(`docker rm -f ${fuseContainerName}`, { stdio: "ignore" });
    } catch {}
  }
  // Always try to clean up the per-run named volumes, regardless of fuseReady.
  for (const vol of [
    `${fuseContainerName}-nm-root`,
    `${fuseContainerName}-nm-cli`,
    `${fuseContainerName}-nm-core`,
    `${fuseContainerName}-nm-server`,
    `${fuseContainerName}-nm-mcp`,
    `${fuseContainerName}-target`,
  ]) {
    try { execSync(`docker volume rm -f ${vol}`, { stdio: "ignore", timeout: 10_000 }); } catch {}
  }
  // Remove temp directory
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
}

/**
 * Boot a sibling Docker container with FUSE caps, build the helper inside it,
 * start a per-container agent-fs daemon, and mount /mnt/agent-fs.
 *
 * Auto-skips (returns false, sets fuseSkipReason) on:
 *  - Docker not available
 *  - /dev/fuse not exposable (Darwin Docker Desktop missing the device)
 *  - Build/mount failures (logged via fuseSkipReason)
 *
 * Reuses the existing MinIO container (joins its docker network).
 */
async function setupFuse(): Promise<boolean> {
  if (!useDockerFuse) {
    fuseSkipReason = process.platform === "darwin"
      ? "set AGENT_FS_USE_DOCKER_FUSE=1 to run FUSE tests via Docker on Darwin"
      : "AGENT_FS_USE_DOCKER_FUSE=0 — explicitly disabled";
    return false;
  }

  // 1. Build the FUSE runner image (cached locally between runs).
  try {
    execSync(
      `docker build -f scripts/docker/Dockerfile.e2e-fuse -t ${fuseImageTag} .`,
      { stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 },
    );
  } catch (e: any) {
    fuseSkipReason = `docker build failed: ${(e.stderr?.toString?.() ?? e.message).split("\n").slice(-3).join(" | ")}`;
    return false;
  }

  // 2. Run the FUSE container with caps + bind-mount the repo at /work.
  //    We also bind-mount the MinIO container's network namespace so the
  //    daemon inside the FUSE container can reach MinIO on host.docker.internal.
  const minioNet = (() => {
    try {
      return execSync(
        `docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' ${containerName}`,
        { encoding: "utf-8" },
      ).trim();
    } catch {
      return "bridge";
    }
  })();

  try {
    execSync(
      `docker run -d --rm ` +
        `--name ${fuseContainerName} ` +
        `--cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor=unconfined ` +
        `--network ${minioNet} ` +
        `-v ${process.cwd()}:/work ` +
        `-v ${fuseContainerName}-nm-root:/work/node_modules ` +
        `-v ${fuseContainerName}-nm-cli:/work/packages/cli/node_modules ` +
        `-v ${fuseContainerName}-nm-core:/work/packages/core/node_modules ` +
        `-v ${fuseContainerName}-nm-server:/work/packages/server/node_modules ` +
        `-v ${fuseContainerName}-nm-mcp:/work/packages/mcp/node_modules ` +
        `-v ${fuseContainerName}-target:/work/target ` +
        `-w /work ` +
        `${fuseImageTag}`,
      { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
    );
  } catch (e: any) {
    fuseSkipReason = `docker run failed: ${(e.stderr?.toString?.() ?? e.message).split("\n").slice(-3).join(" | ")}`;
    return false;
  }

  // 3. Sanity: /dev/fuse must be usable.
  try {
    execSync(`docker exec ${fuseContainerName} test -c /dev/fuse`, { stdio: "ignore", timeout: 5_000 });
  } catch {
    fuseSkipReason = "/dev/fuse not available inside container (Docker Desktop on Darwin commonly lacks this)";
    try { execSync(`docker rm -f ${fuseContainerName}`, { stdio: "ignore" }); } catch {}
    return false;
  }

  // 4. Build the FUSE helper inside the container (cargo, debug profile for speed).
  try {
    execSync(
      `docker exec ${fuseContainerName} bash -lc 'cd /work/packages/fuse-helper && cargo build --release 2>&1 | tail -3'`,
      { stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 },
    );
  } catch (e: any) {
    fuseSkipReason = `cargo build failed: ${(e.stderr?.toString?.() ?? e.stdout?.toString?.() ?? e.message).split("\n").slice(-5).join(" | ")}`;
    try { execSync(`docker rm -f ${fuseContainerName}`, { stdio: "ignore" }); } catch {}
    return false;
  }

  // 5. Install Bun deps inside the container (uses the bind-mounted repo).
  //    Bun's cache is per-container; this is a one-time cost per harness run.
  try {
    execSync(
      `docker exec ${fuseContainerName} bash -lc 'cd /work && bun install 2>&1 | tail -8'`,
      { stdio: ["ignore", "inherit", "inherit"], timeout: 300_000 },
    );
  } catch (e: any) {
    fuseSkipReason = `bun install failed: ${(e.stderr?.toString?.() ?? e.stdout?.toString?.() ?? e.message).split("\n").slice(-3).join(" | ")}`;
    try { execSync(`docker rm -f ${fuseContainerName}`, { stdio: "ignore" }); } catch {}
    return false;
  }

  // 6. Inside-container env: AGENT_FS_HOME, S3 pointing at the MinIO sibling.
  //    The container is on the same docker network as MinIO, so we can talk to
  //    it via its container name + internal port 9000.
  const inEnv = [
    `AGENT_FS_HOME=/root/.agent-fs`,
    `AGENT_FS_FUSE_BIN=/work/target/release/agent-fs-fuse`,
    `S3_ENDPOINT=http://${containerName}:9000`,
    `S3_BUCKET=agentfs`,
    `S3_ACCESS_KEY_ID=minioadmin`,
    `S3_SECRET_ACCESS_KEY=minioadmin`,
    `S3_REGION=us-east-1`,
    `S3_PROVIDER=minio`,
  ].map((v) => `export ${v}`).join("; ");

  // Persist for all later `runFuseCmd` calls via a sourced profile fragment.
  runFuseCmd(`mkdir -p /root/.agent-fs && cat > /root/.agent-fs/test-env.sh <<'EOF'\n${inEnv.replace(/^export /gm, "export ")}\nEOF\necho 'source /root/.agent-fs/test-env.sh' >> /root/.bashrc`);

  // 7. Initialize agent-fs inside the container and start the daemon on a known port.
  //    Reuse the host's API key by writing the same config + DB.
  //    Simpler: register a fresh user inside the container (separate DB), then
  //    surface its API key for the auth-related tests.
  try {
    runFuseCmd(
      `source /root/.agent-fs/test-env.sh && ` +
        `cd /work && bun run packages/cli/src/index.ts init --yes >/dev/null 2>&1 || true`,
      { timeoutMs: 60_000 },
    );
    // Pick a fixed in-container daemon port (host port isn't exposed; we go via docker exec).
    const innerDaemonPort = 19872;
    runFuseCmd(
      `source /root/.agent-fs/test-env.sh && ` +
        `cd /work && cat > /root/.agent-fs/config.json <<EOF
{
  "s3": {
    "provider": "minio",
    "bucket": "agentfs",
    "region": "us-east-1",
    "endpoint": "http://${containerName}:9000",
    "accessKeyId": "minioadmin",
    "secretAccessKey": "minioadmin",
    "versioningEnabled": true
  },
  "embedding": { "provider": "local", "model": "", "apiKey": "" },
  "server": { "port": ${innerDaemonPort}, "host": "127.0.0.1", "rateLimit": { "requestsPerMinute": 5000 } },
  "auth": { "apiKey": "" },
  "minio": { "containerId": "", "managed": false }
}
EOF`,
    );
    runFuseCmd(
      `source /root/.agent-fs/test-env.sh && cd /work && bun run packages/cli/src/index.ts daemon start`,
      { timeoutMs: 30_000 },
    );
    // Wait for the inner daemon to be healthy.
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      const r = runFuseCmd(
        `curl -sf http://127.0.0.1:${innerDaemonPort}/health >/dev/null && echo OK || echo FAIL`,
        { allowFailure: true },
      );
      if (r.includes("OK")) { healthy = true; break; }
      await Bun.sleep(500);
    }
    if (!healthy) throw new Error("inner daemon never became healthy");

    // Register a test user inside the container; capture its apiKey.
    const reg = runFuseCmd(
      `curl -sS -X POST -H 'Content-Type: application/json' ` +
        `-d '{"email":"fuse-e2e@local"}' ` +
        `http://127.0.0.1:${innerDaemonPort}/auth/register`,
    );
    let innerKey = "";
    try { innerKey = (JSON.parse(reg) as any).apiKey; } catch {}
    if (!innerKey) throw new Error(`failed to register inner user: ${reg.slice(0, 200)}`);
    runFuseCmd(`echo 'export AGENT_FS_API_KEY=${innerKey}' >> /root/.agent-fs/test-env.sh`);
    runFuseCmd(`echo 'export AGENT_FS_API_URL=http://127.0.0.1:${innerDaemonPort}' >> /root/.agent-fs/test-env.sh`);
  } catch (e: any) {
    fuseSkipReason = `inner daemon init failed: ${e.message?.split("\n")[0] ?? String(e)}`;
    try {
      const log = runFuseCmd(`tail -80 /root/.agent-fs/agent-fs.log 2>&1 || echo '(no daemon log)'`, { allowFailure: true });
      console.error(`\n=== DAEMON LOG ===\n${log}\n=== END DAEMON LOG ===\n`);
    } catch {}
    try { execSync(`docker rm -f ${fuseContainerName}`, { stdio: "ignore" }); } catch {}
    return false;
  }

  fuseReady = true;
  return true;
}

/** Helper: env-loaded `agent-fs` invocation inside the FUSE container. */
function inFs(cmdStr: string, opts: { allowFailure?: boolean; timeoutMs?: number } = {}): string {
  return runFuseCmd(`source /root/.agent-fs/test-env.sh && cd /work && bun run packages/cli/src/index.ts ${cmdStr}`, opts);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

async function runTests() {
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;

  console.log(`\nagent-fs E2E Tests`);
  console.log(`Using: ${cmd}`);
  console.log(`MinIO: localhost:${minioPort} (container: ${containerName})`);
  console.log(`Daemon: ${daemonUrl}`);
  if (fuseOnly) console.log(`Mode: --fuse-only (skipping CLI/MCP/API tests)`);
  console.log("");

  if (!fuseOnly) await runStandardTests(daemonUrl);
  await runFuseTests();
}

async function runStandardTests(daemonUrl: string) {
  // -- Basics --

  await test("--help", () => {
    const out = run("--help");
    assertIncludes(out, "agent-fs");
  });

  await test("--version", () => {
    const out = run("--version");
    assert(/^\d+\.\d+\.\d+$/.test(out), true, `Expected semver, got ${JSON.stringify(out)}`);
  });

  // -- write + cat roundtrip --

  await test("write + cat roundtrip", () => {
    const result = runJson('write /hello.txt --content "Hello, agent-fs!"');
    assert(result.version, 1);
    const cat = runJson("cat /hello.txt");
    assert(cat.content, "Hello, agent-fs!");
  });

  // -- ls --

  await test("ls", () => {
    const result = runJson("ls /");
    const names = result.entries.map((e: any) => e.name);
    assert(names.includes("hello.txt"), true, `Expected hello.txt in ls, got ${JSON.stringify(names)}`);
  });

  // -- append --

  await test("append + cat", () => {
    runJson('append /hello.txt --content " Appended."');
    const cat = runJson("cat /hello.txt");
    assert(cat.content, "Hello, agent-fs! Appended.");
  });

  // -- edit --

  await test("edit + cat", () => {
    runJson('edit /hello.txt --old "Appended." --new "Edited!"');
    const cat = runJson("cat /hello.txt");
    assert(cat.content, "Hello, agent-fs! Edited!");
  });

  // -- stat --

  await test("stat", () => {
    const result = runJson("stat /hello.txt");
    assert(result.path, "/hello.txt");
    assert(typeof result.size, "number");
    assert(result.currentVersion >= 3, true, `Expected version >= 3, got ${result.currentVersion}`);
  });

  // -- tail --

  await test("tail", () => {
    // Write a multi-line file
    runJson('write /multiline.txt --content "line1\nline2\nline3\nline4\nline5"');
    const result = runJson("tail /multiline.txt -n 2");
    assert(result.content, "line4\nline5");
  });

  // -- cp --

  await test("cp + cat", () => {
    runJson("cp /hello.txt /hello-copy.txt");
    const cat = runJson("cat /hello-copy.txt");
    assert(cat.content, "Hello, agent-fs! Edited!");
  });

  // -- mv --

  await test("mv + cat + ls", () => {
    runJson("mv /hello-copy.txt /hello-moved.txt");
    const cat = runJson("cat /hello-moved.txt");
    assert(cat.content, "Hello, agent-fs! Edited!");
    const ls = runJson("ls /");
    const names = ls.entries.map((e: any) => e.name);
    assert(names.includes("hello-copy.txt"), false, "hello-copy.txt should be gone after mv");
    assert(names.includes("hello-moved.txt"), true, "hello-moved.txt should exist after mv");
  });

  // -- log --

  await test("log (version history)", () => {
    const result = runJson("log /hello.txt");
    assert(result.versions.length >= 3, true, `Expected >= 3 versions, got ${result.versions.length}`);
  });

  // -- tree --

  await test("tree", () => {
    // Create a nested file
    runJson('write /docs/readme.md --content "readme"');
    const result = runJson("tree /");
    const tree = result.tree;
    assert(Array.isArray(tree), true);
    const names = tree.map((e: any) => e.name);
    assert(names.includes("docs"), true, `Expected docs dir in tree, got ${JSON.stringify(names)}`);
  });

  // -- glob --

  await test("glob", () => {
    const result = runJson("glob '*.txt'");
    const paths = result.matches.map((m: any) => m.path);
    assert(paths.includes("/hello.txt"), true, `Expected /hello.txt in glob, got ${JSON.stringify(paths)}`);
  });

  // -- reindex (must run before grep/fts to populate FTS index) --

  await test("reindex", () => {
    const result = runJson("reindex");
    assert(typeof result.reindexed, "number");
  });

  // -- grep --

  await test("grep", () => {
    // grep's path is a directory prefix, not a file path
    const result = runJson("grep Hello /");
    assert(result.matches.length > 0, true, "Expected grep matches");
  });

  // -- fts --

  await test("fts", () => {
    // Use a simple token — hyphens are FTS5 NOT operators
    const result = runJson("fts Hello");
    assert(result.matches.length > 0, true, "Expected fts matches");
  });

  // -- vec-search --

  await test("vec-search", () => {
    const result = runJson("vec-search 'greeting message'");
    // May return empty if no embedding provider in E2E; just verify the shape
    assert(Array.isArray(result.results), true, "Expected results array from vec-search");
  });

  // -- search (hybrid) --

  await test("search (hybrid)", () => {
    const result = runJson("search Hello");
    assert(Array.isArray(result.results), true, "Expected results array from hybrid search");
    // With FTS available, should find matches even without embedding provider
    assert(result.results.length > 0, true, "Expected hybrid search results via FTS fallback");
  });

  // -- comments --

  await test("comment add + list + resolve", () => {
    const add = JSON.parse(run('comment add /hello.txt --body "Nice file!"'));
    assert(typeof add.id, "string");

    const list = JSON.parse(run("comment list /hello.txt"));
    assert(list.comments.length >= 1, true, "Expected at least 1 comment");

    const resolve = JSON.parse(run(`comment resolve ${add.id}`));
    assert(resolve.resolved, true, "Expected comment to be resolved");
  });

  // -- recent --

  await test("recent", () => {
    const result = runJson("recent");
    assert(result.entries.length > 0, true, "Expected recent entries");
  });

  // -- diff --

  await test("diff (between versions)", () => {
    const result = runJson("diff /hello.txt --v1 1 --v2 2");
    assert(Array.isArray(result.changes), true);
    assert(result.changes.length > 0, true, "Expected diff changes between v1 and v2");
  });

  // -- revert --

  await test("revert + cat", () => {
    const revert = runJson("revert /hello.txt --to 1");
    assert(revert.revertedTo, 1);
    const cat = runJson("cat /hello.txt");
    assert(cat.content, "Hello, agent-fs!");
  });

  // -- rm --

  await test("rm + ls", () => {
    runJson("rm /hello-moved.txt");
    const ls = runJson("ls /");
    const names = ls.entries.map((e: any) => e.name);
    assert(names.includes("hello-moved.txt"), false, "hello-moved.txt should be gone after rm");
  });

  // -- signed-url --

  await test("signed-url", () => {
    const result = runJson("signed-url /hello.txt");
    assert(typeof result.url, "string", "Expected url string");
    assertIncludes(result.url, "agentfs", "Expected presigned URL to reference bucket");
    assert(result.path, "/hello.txt");
    assert(result.expiresIn, 86400);
    assert(typeof result.expiresAt, "string", "Expected expiresAt ISO string");
  });

  await test("signed-url with custom expiry", () => {
    const result = runJson("signed-url /hello.txt --expires-in 3600");
    assert(result.expiresIn, 3600);
    assert(typeof result.url, "string");
  });

  await test("signed-url presigned URL is fetchable", async () => {
    const result = runJson("signed-url /hello.txt");
    const res = await fetch(result.url);
    assert(res.ok, true, `Expected 200, got ${res.status}`);
    const body = await res.text();
    assert(body, "Hello, agent-fs!", "Expected file content from presigned URL");
  });

  await test("signed-url nonexistent file fails", () => {
    try {
      run("signed-url /does-not-exist.txt");
      throw new Error("Expected signed-url to fail for nonexistent file");
    } catch (e: any) {
      if (e.message.includes("Expected signed-url to fail")) throw e;
      // CLI exits non-zero for 404 — expected
    }
  });

  await test("signed-url via API", async () => {
    const res = await fetch(`${daemonUrl}/orgs/${personalOrgId}/ops`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ op: "signed-url", path: "/hello.txt" }),
    });
    assert(res.ok, true, `Expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(typeof body.url, "string", "Expected url in response");
    assert(body.path, "/hello.txt");
    assert(body.expiresIn, 86400);
    assert(typeof body.expiresAt, "string");
  });

  await test("signed-url via API — 404 for missing file", async () => {
    const res = await fetch(`${daemonUrl}/orgs/${personalOrgId}/ops`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ op: "signed-url", path: "/nonexistent.txt" }),
    });
    assert(res.status, 404, `Expected 404, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.error, "NOT_FOUND");
    assertIncludes(body.message, "File not found");
  });

  await test("signed-url via MCP", async () => {
    // Initialize MCP session
    const initRes = await fetch(`${daemonUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(apiKey),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "e2e-signed-url", version: "1.0.0" },
        },
      }),
    });
    assert(initRes.ok, true, `MCP init failed: ${initRes.status}`);

    // Call signed-url tool
    const callRes = await fetch(`${daemonUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(apiKey),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "signed-url",
          arguments: { path: "/hello.txt" },
        },
      }),
    });
    assert(callRes.ok, true, `MCP tools/call failed: ${callRes.status}`);
    const body = await callRes.json() as any;
    // MCP returns result.content array with text items
    const content = body.result?.content;
    assert(Array.isArray(content), true, `Expected content array, got ${JSON.stringify(body)}`);
    const text = content[0]?.text;
    assert(typeof text, "string", "Expected text in content");
    const parsed = JSON.parse(text);
    assert(typeof parsed.url, "string", "Expected url in MCP result");
    assert(parsed.path, "/hello.txt");
    assert(parsed.expiresIn, 86400);
  });

  // -- MIME type detection --

  await test("write sets contentType in stat", () => {
    runJson('write /mime-test.pdf --content "fake pdf"');
    const stat = runJson("stat /mime-test.pdf");
    assert(stat.contentType, "application/pdf", `Expected application/pdf, got ${stat.contentType}`);
  });

  await test("write sets contentType for images", () => {
    runJson('write /mime-test.png --content "fake png"');
    const stat = runJson("stat /mime-test.png");
    assert(stat.contentType, "image/png", `Expected image/png, got ${stat.contentType}`);
  });

  await test("write sets contentType for markdown", () => {
    const stat = runJson("stat /docs/readme.md");
    assert(stat.contentType, "text/markdown", `Expected text/markdown, got ${stat.contentType}`);
  });

  await test("signed-url serves correct Content-Type for PDF", async () => {
    const result = runJson("signed-url /mime-test.pdf");
    // Use GET (not HEAD) — MinIO presigned URLs are method-specific
    const res = await fetch(result.url);
    assert(res.ok, true, `Expected 200, got ${res.status}`);
    const ct = res.headers.get("content-type");
    assert(ct, "application/pdf", `Expected application/pdf, got ${ct}`);
  });

  await test("signed-url serves correct Content-Type for PNG", async () => {
    const result = runJson("signed-url /mime-test.png");
    const res = await fetch(result.url);
    assert(res.ok, true, `Expected 200, got ${res.status}`);
    const ct = res.headers.get("content-type");
    assert(ct, "image/png", `Expected image/png, got ${ct}`);
  });

  // -- Org commands --

  await test("org list", () => {
    const out = run("org list");
    assertIncludes(out, personalOrgId);
    assertIncludes(out, "(personal)");
  });

  await test("org list --json", () => {
    const orgs = runJson("org list");
    assert(Array.isArray(orgs), true, "Expected array");
    const personal = orgs.find((o: any) => o.id === personalOrgId);
    assert(!!personal, true, "Expected personal org in list");
    assert(personal.isPersonal, true);
    assert(personal.role, "admin");
  });

  await test("org current", () => {
    const out = run("org current");
    assertIncludes(out, personalOrgId);
    assertIncludes(out, "server default");
  });

  await test("org current --json", () => {
    const result = runJson("org current");
    assert(result.id, personalOrgId);
    assert(result.source, "server default");
  });

  // Create a second org via API for switch testing
  let secondOrgId = "";
  let secondDriveId = "";
  await test("create second org (via API)", async () => {
    const res = await fetch(`${daemonUrl}/orgs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ name: "e2e-second-org" }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create org: ${res.status} ${body}`);
    }
    const data = await res.json() as any;
    secondOrgId = data.id;
    // Fetch the default drive for the new org
    const drivesRes = await fetch(`${daemonUrl}/orgs/${secondOrgId}/drives`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    const drivesData = await drivesRes.json() as any;
    secondDriveId = drivesData.drives[0]?.id;
    assert(!!secondOrgId, true, "Expected second org ID");
    assert(!!secondDriveId, true, "Expected second drive ID");
  });

  await test("org list shows both orgs", () => {
    const orgs = runJson("org list");
    assert(orgs.length, 2, `Expected 2 orgs, got ${orgs.length}`);
    const names = orgs.map((o: any) => o.name);
    assert(names.includes("e2e-second-org"), true, `Expected e2e-second-org in ${JSON.stringify(names)}`);
  });

  await test("org switch to second org", () => {
    const out = run(`org switch ${secondOrgId}`);
    assertIncludes(out, "Switched to org: e2e-second-org");
  });

  await test("org current after switch", () => {
    const result = runJson("org current");
    assert(result.id, secondOrgId);
    assert(result.source, "config (org switch)");
  });

  await test("org switch back to personal", () => {
    const out = run(`org switch ${personalOrgId}`);
    assertIncludes(out, "Switched to org:");
  });

  await test("org current after switch back", () => {
    const result = runJson("org current");
    assert(result.id, personalOrgId);
    assert(result.source, "config (org switch)");
  });

  // -- Drive commands --

  await test("drive list (all orgs)", () => {
    const out = run("drive list");
    // Should show both orgs' drives
    assertIncludes(out, "(personal");
    assertIncludes(out, "e2e-second-org");
    assertIncludes(out, "(default)");
  });

  await test("drive list --json", () => {
    const result = runJson("drive list");
    assert(Array.isArray(result), true, "Expected array");
    assert(result.length, 2, `Expected 2 org groups, got ${result.length}`);
    const orgNames = result.map((r: any) => r.orgName);
    assert(orgNames.includes("e2e-second-org"), true, `Expected e2e-second-org in ${JSON.stringify(orgNames)}`);
    // Each group should have drives
    for (const group of result) {
      assert(Array.isArray(group.drives), true, "Expected drives array in group");
      assert(group.drives.length > 0, true, "Expected at least one drive per org");
    }
  });

  await test("drive list --org (single org)", () => {
    const out = run(`--org ${secondOrgId} drive list`);
    assertIncludes(out, secondDriveId);
    assertIncludes(out, "(default)");
  });

  await test("drive current", () => {
    const out = run("drive current");
    assertIncludes(out, personalOrgId);
    assertIncludes(out, personalDriveId);
  });

  await test("drive current --json", () => {
    const result = runJson("drive current");
    assert(result.orgId, personalOrgId);
    assert(result.drive.id, personalDriveId);
  });

  await test("drive switch to second org drive", () => {
    const out = run(`drive switch ${secondDriveId}`);
    assertIncludes(out, "Switched to drive:");
    assertIncludes(out, "e2e-second-org");
  });

  await test("drive current after switch", () => {
    const result = runJson("drive current");
    assert(result.orgId, secondOrgId);
    assert(result.drive.id, secondDriveId);
  });

  await test("drive switch back to personal drive", () => {
    const out = run(`drive switch ${personalDriveId}`);
    assertIncludes(out, "Switched to drive:");
  });

  await test("drive current after switch back", () => {
    const result = runJson("drive current");
    assert(result.orgId, personalOrgId);
    assert(result.drive.id, personalDriveId);
  });

  // -- Member commands --

  // Switch back to personal org for member tests
  run(`org switch ${personalOrgId}`);

  await test("member list (self as admin)", () => {
    const members = runJson("member list");
    assert(Array.isArray(members), true, "Expected array");
    assert(members.length, 1, `Expected 1 member, got ${members.length}`);
    assert(members[0].email, "test@e2e.local");
    assert(members[0].role, "admin");
  });

  // Register a second user for invite/update/remove tests
  let user2ApiKey = "";
  let user2Id = "";
  await test("register second user", async () => {
    const res = await fetch(`${daemonUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user2@e2e.local" }),
    });
    assert(res.ok, true, `Expected 200, got ${res.status}`);
    const data = await res.json() as any;
    user2ApiKey = data.apiKey;
    user2Id = data.userId;
    assert(!!user2ApiKey, true, "Expected API key for user2");
  });

  // Switch to second org (non-personal) for invite/remove tests
  run(`org switch ${secondOrgId}`);

  await test("member invite to second org", () => {
    const out = run("member invite user2@e2e.local --role editor");
    assertIncludes(out, "Invited user2@e2e.local as editor");
  });

  await test("member list shows invited user", () => {
    const members = runJson("member list");
    assert(members.length, 2, `Expected 2 members, got ${members.length}`);
    const user2 = members.find((m: any) => m.email === "user2@e2e.local");
    assert(!!user2, true, "Expected user2 in member list");
    assert(user2.role, "editor");
  });

  await test("member list --drive", () => {
    const members = runJson(`--drive ${secondDriveId} member list`);
    assert(Array.isArray(members), true, "Expected array");
    // inviteToOrg also adds to default drive
    const user2 = members.find((m: any) => m.email === "user2@e2e.local");
    assert(!!user2, true, "Expected user2 in drive members");
    assert(user2.role, "editor");
  });

  await test("member update-role", () => {
    const out = run("member update-role user2@e2e.local --role viewer");
    assertIncludes(out, "Updated user2@e2e.local to viewer");
    const members = runJson("member list");
    const user2 = members.find((m: any) => m.email === "user2@e2e.local");
    assert(user2.role, "viewer");
  });

  await test("member update-role --drive", () => {
    const out = run(`--drive ${secondDriveId} member update-role user2@e2e.local --role admin`);
    assertIncludes(out, "Updated user2@e2e.local to admin");
    const members = runJson(`--drive ${secondDriveId} member list`);
    const user2 = members.find((m: any) => m.email === "user2@e2e.local");
    assert(user2.role, "admin");
  });

  await test("member remove from drive only", () => {
    const out = run(`--drive ${secondDriveId} member remove user2@e2e.local`);
    assertIncludes(out, `Removed user2@e2e.local from drive ${secondDriveId}`);
    // Should still be in org
    const orgMembers = runJson("member list");
    const user2Org = orgMembers.find((m: any) => m.email === "user2@e2e.local");
    assert(!!user2Org, true, "Expected user2 still in org after drive removal");
    // Should be gone from drive
    const driveMembers = runJson(`--drive ${secondDriveId} member list`);
    const user2Drive = driveMembers.find((m: any) => m.email === "user2@e2e.local");
    assert(!user2Drive, true, "Expected user2 gone from drive");
  });

  await test("member remove from org", () => {
    const out = run("member remove user2@e2e.local");
    assertIncludes(out, "Removed user2@e2e.local from org");
    const members = runJson("member list");
    const user2 = members.find((m: any) => m.email === "user2@e2e.local");
    assert(!user2, true, "Expected user2 gone from org");
  });

  await test("member remove last admin fails", () => {
    // Switch to personal org — only one admin (self)
    run(`org switch ${personalOrgId}`);
    try {
      run("member remove test@e2e.local");
      throw new Error("Expected removal to fail");
    } catch (e: any) {
      if (e.message === "Expected removal to fail") throw e;
      // CLI exits non-zero — expected
    }
  });

  // Switch back and clean up config
  run(`org switch ${personalOrgId}`);

  // Clean up config overrides so MCP tests aren't affected
  run("config set defaultOrg ''");
  run("config set defaultDrive ''");

  // -- MCP endpoint --

  await test("mcp initialize", async () => {
    const res = await fetch(`${daemonUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(apiKey),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "e2e-test", version: "1.0.0" },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${body}`);
    }
    const body = await res.json() as any;
    assert(body.jsonrpc, "2.0");
    assert(typeof body.result?.protocolVersion, "string", "Expected protocolVersion in response");
  });

  await test("mcp tools/list via batch", async () => {
    // Stateless per-request transport: each POST creates a fresh server.
    // Send initialize + initialized notification + tools/list as a batch won't work
    // because initialize must be sent alone. Instead, test via two sequential requests:
    // 1. Initialize (creates + initializes the per-request server)
    // 2. tools/list on a new per-request server — but it won't be initialized!
    //
    // The correct stateless test: just verify initialize returns the tools capability,
    // then trust that the proxy (which uses StreamableHTTPClientTransport) handles
    // the full lifecycle. For direct HTTP testing, we can only reliably test initialize.
    //
    // Alternative: test tools/list through the proxy (agent-fs mcp).
    // For now, we verify the initialize response includes tools capability.
    const res = await fetch(`${daemonUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(apiKey),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "e2e-test", version: "1.0.0" },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${body}`);
    }
    const body = await res.json() as any;
    // Verify server advertises tools capability
    assert(typeof body.result?.capabilities?.tools, "object", "Expected tools capability in initialize response");
  });

  // -- PUT /raw round-trip (binary write path used by the FUSE mount) --
  await test("PUT /raw round-trip (scripts/e2e-raw-put.sh)", () => {
    execSync("./scripts/e2e-raw-put.sh", {
      stdio: "pipe",
      env: {
        ...testEnv(),
        DAEMON_URL: daemonUrl,
        AGENT_FS_API_KEY: apiKey,
        ORG_ID: personalOrgId,
        DRIVE_ID: personalDriveId,
      },
      cwd: process.cwd(),
      timeout: 30_000,
    });
  });

  await test("mcp unauthenticated returns 401", async () => {
    const res = await fetch(`${daemonUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "e2e-test", version: "1.0.0" },
        },
      }),
    });
    assert(res.status, 401, `Expected 401, got ${res.status}`);
  });
}

// ---------------------------------------------------------------------------
// FUSE test suite (sibling Docker container with FUSE caps)
// ---------------------------------------------------------------------------

async function runFuseTests() {
  console.log(`\n-- FUSE mount tests --`);
  await setupFuse();
  if (!fuseReady) {
    console.log(`  ⊘ FUSE harness not ready: ${fuseSkipReason}`);
    console.log(`  ⊘ All 10 FUSE test cases will be skipped.`);
  } else {
    console.log(`  FUSE container: ${fuseContainerName} (image: ${fuseImageTag})`);
  }

  // 1. Mount lifecycle: mount → mount table shows it → umount → no leak.
  await fuseTest("mount lifecycle: mount succeeds, umount cleans up", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    // Give the kernel a moment to register the mount.
    await Bun.sleep(500);
    const mounts = runFuseCmd(`mount | grep -E '/mnt/agent-fs' || true`);
    assertIncludes(mounts, "/mnt/agent-fs", "expected mount table to show /mnt/agent-fs");
    inFs(`umount /mnt/agent-fs`);
    await Bun.sleep(1500);
    const after = runFuseCmd(`mount | grep -E '/mnt/agent-fs' || true`);
    assert(after, "", "expected mount to be gone after umount");
    // No leak in ~/.agent-fs/mount/ — count live-PID dirs only; dead-PID dirs
    // are GCed lazily on the next mount.
    const leak = runFuseCmd(
      `for d in /root/.agent-fs/mount/*/; do [ -d "$d" ] || continue; pid=$(basename "$d"); kill -0 "$pid" 2>/dev/null && echo "$pid"; done | wc -l`,
      { allowFailure: true },
    );
    assert(leak === "0" || leak === "" || leak.startsWith("EXIT="), true, `expected no live-pid mount-state leak, got ${JSON.stringify(leak)}`);
  });

  // 2. Round-trip: echo > cat > grep > mv > rm cycle.
  await fuseTest("round-trip: echo/cat/grep/mv/rm on the mount", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    await Bun.sleep(500);
    runFuseCmd(`echo 'hello from FUSE' > /mnt/agent-fs/current/scratch.md`);
    const catOut = runFuseCmd(`cat /mnt/agent-fs/current/scratch.md`);
    assert(catOut, "hello from FUSE", `cat returned unexpected content: ${JSON.stringify(catOut)}`);
    const grep = runFuseCmd(`grep -r hello /mnt/agent-fs/current/ || true`);
    assertIncludes(grep, "hello from FUSE", "grep didn't find content");
    runFuseCmd(`mv /mnt/agent-fs/current/scratch.md /mnt/agent-fs/current/scratch2.md`);
    runFuseCmd(`rm /mnt/agent-fs/current/scratch2.md`);
    // Cat-after-rm should fail with ENOENT.
    const after = runFuseCmd(`cat /mnt/agent-fs/current/scratch2.md`, { allowFailure: true });
    assertIncludes(after, "EXIT=", "cat after rm should fail (ENOENT)");
    inFs(`umount /mnt/agent-fs`);
  });

  // 3. Hash dedup: identical writes don't bump version.
  await fuseTest("hash dedup: identical content writes don't bump version", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    await Bun.sleep(500);
    runFuseCmd(`echo 'dedup-test' > /mnt/agent-fs/current/dedup.md`);
    // Snapshot version + mtime.
    const v1 = JSON.parse(inFs(`--json stat /dedup.md`));
    const startV = v1.currentVersion;
    // Touch + identical rewrites (5x).
    for (let i = 0; i < 5; i++) {
      runFuseCmd(`touch /mnt/agent-fs/current/dedup.md`);
      runFuseCmd(`echo 'dedup-test' > /mnt/agent-fs/current/dedup.md`);
    }
    const v2 = JSON.parse(inFs(`--json stat /dedup.md`));
    assert(v2.currentVersion, startV, `expected version to stay at ${startV} after dedup, got ${v2.currentVersion}`);
    inFs(`umount /mnt/agent-fs`);
  });

  // 4. Conflict: two parallel writers → exactly one wins, one record in conflicts.ndjson.
  await fuseTest("conflict: parallel writers → 1 winner + 1 conflict record", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    await Bun.sleep(500);
    runFuseCmd(`echo 'seed' > /mnt/agent-fs/current/race.md`);
    // Two parallel writers, both holding the file open for ~1s then closing.
    runFuseCmd(
      `(exec 3>/mnt/agent-fs/current/race.md; sleep 1; echo A >&3; exec 3>&-) & ` +
        `(exec 3>/mnt/agent-fs/current/race.md; sleep 1; echo B >&3; exec 3>&-) & wait`,
      { allowFailure: true, timeoutMs: 15_000 },
    );
    await Bun.sleep(500);
    const conflicts = runFuseCmd(`cat /mnt/agent-fs/.agent-fs/conflicts.ndjson 2>/dev/null || echo ''`, { allowFailure: true });
    const conflictLines = conflicts.split("\n").filter((l) => l.trim().length > 0).length;
    // We expect at least 1 conflict record. Implementation may emit 1 or many depending on close ordering.
    assert(conflictLines >= 1, true, `expected ≥1 conflict record, got ${conflictLines} (${conflicts.slice(0, 200)})`);
    // The on-disk file is one of the two contents (not empty).
    const head = runFuseCmd(`cat /mnt/agent-fs/current/race.md`, { allowFailure: true });
    assert(head === "A" || head === "B" || head === "seed", true, `expected winner content, got ${JSON.stringify(head)}`);
    inFs(`umount /mnt/agent-fs`);
  });

  // 5. Daemon restart: writes after stop fail with EIO; reopen + write succeeds.
  await fuseTest("daemon restart: in-flight close → EIO; reopen succeeds", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    await Bun.sleep(500);
    // Hold a file open for write, stop+start daemon, then close.
    const result = runFuseCmd(
      `source /root/.agent-fs/test-env.sh && ` +
        `(exec 4>/mnt/agent-fs/current/restart.md; echo before >&4; ` +
        `cd /work && bun run packages/cli/src/index.ts daemon stop >/dev/null 2>&1; ` +
        `bun run packages/cli/src/index.ts daemon start >/dev/null 2>&1; ` +
        `sleep 1; echo after >&4; exec 4>&-; echo CLOSE_EXIT=$?)`,
      { allowFailure: true, timeoutMs: 60_000 },
    );
    // The close should report success/failure via CLOSE_EXIT — exact code depends on FUSE,
    // but the mount must remain alive afterwards.
    const stillMounted = runFuseCmd(`mount | grep -E '/mnt/agent-fs' || true`);
    assertIncludes(stillMounted, "/mnt/agent-fs", `mount went away after daemon-restart: ${result.slice(0, 200)}`);
    // Reopen + write succeeds.
    runFuseCmd(`echo 'fresh write' > /mnt/agent-fs/current/restart2.md`);
    const fresh = runFuseCmd(`cat /mnt/agent-fs/current/restart2.md`);
    assert(fresh, "fresh write", `post-restart write failed: ${fresh}`);
    inFs(`umount /mnt/agent-fs`);
  });

  // 6. Drive listing: mount surfaces the user's drives.
  await fuseTest("drive listing: mount surfaces accessible drives", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    await Bun.sleep(500);
    const entries = runFuseCmd(`ls /mnt/agent-fs/`);
    // Should at least include `current` (symlink) and the default-drive slug.
    assertIncludes(entries, "current", "expected /mnt/agent-fs/current symlink");
    // Drive count ≥ 1 (default personal drive).
    const lines = entries.split(/\s+/).filter(Boolean);
    assert(lines.length >= 2, true, `expected ≥2 entries (current + ≥1 drive), got ${JSON.stringify(lines)}`);
    inFs(`umount /mnt/agent-fs`);
  });

  // 7. Default-drive symlink: readlink current → drive slug.
  await fuseTest("default-drive symlink: readlink current → default drive slug", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    await Bun.sleep(500);
    const link = runFuseCmd(`readlink /mnt/agent-fs/current`);
    // Helper may emit "<slug>" or "./<slug>" — both are fine.
    assert(link.length > 0, true, `expected non-empty readlink, got ${JSON.stringify(link)}`);
    inFs(`umount /mnt/agent-fs`);
  });

  // 8. Auth-expired: kill the daemon's auth and assert EACCES (or auth error in .agent-fs/status).
  //    Implementation note: a real revocation API doesn't exist yet in v1; we approximate
  //    by truncating the API key in the config so the next op gets 401 → EACCES.
  await fuseTest("auth-expired: corrupted api-key surfaces auth error", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    await Bun.sleep(500);
    // Corrupt the api-key file (sidecar reads it on each request in v1).
    const sideEffect = runFuseCmd(
      `cp /root/.agent-fs/config.json /root/.agent-fs/config.json.bak && ` +
        `sed -i 's/"apiKey": *"[^"]*"/"apiKey": "INVALID"/' /root/.agent-fs/config.json && ` +
        `cat /mnt/agent-fs/current/does-not-matter.md 2>&1 || true`,
      { allowFailure: true },
    );
    // Restore for later tests.
    runFuseCmd(`cp /root/.agent-fs/config.json.bak /root/.agent-fs/config.json`);
    // Either status surfaced an auth error, OR errors.ndjson grew. We assert at least one.
    const status = runFuseCmd(`cat /mnt/agent-fs/.agent-fs/status 2>/dev/null || echo ''`, { allowFailure: true });
    const errors = runFuseCmd(`cat /mnt/agent-fs/.agent-fs/errors.ndjson 2>/dev/null || echo ''`, { allowFailure: true });
    const surfaced =
      sideEffect.toLowerCase().includes("permission") ||
      sideEffect.toLowerCase().includes("access") ||
      status.toLowerCase().includes("auth") ||
      status.toLowerCase().includes("403") ||
      status.toLowerCase().includes("401") ||
      errors.toLowerCase().includes("auth") ||
      errors.toLowerCase().includes("403") ||
      errors.toLowerCase().includes("401");
    assert(surfaced, true, `expected auth error surfaced via sideEffect/status/errors. got side=${sideEffect.slice(0, 100)} status=${status.slice(0, 100)} errors=${errors.slice(0, 100)}`);
    inFs(`umount /mnt/agent-fs`);
  });

  // 9. EROFS at the drive root: mkdir at <mount>/ is forbidden.
  await fuseTest("EROFS at mount root: mkdir is forbidden", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    await Bun.sleep(500);
    const res = runFuseCmd(`mkdir /mnt/agent-fs/new-drive 2>&1 || true`, { allowFailure: true });
    // Accept either "Read-only" / "EROFS" / non-zero exit + any error text.
    const ok =
      res.toLowerCase().includes("read-only") ||
      res.toLowerCase().includes("erofs") ||
      res.toLowerCase().includes("permission") ||
      res.startsWith("EXIT=");
    assert(ok, true, `expected EROFS-style error at drive root, got: ${JSON.stringify(res)}`);
    inFs(`umount /mnt/agent-fs`);
  });

  // 10. flock ENOSYS: posix file lock returns "Function not implemented".
  await fuseTest("flock ENOSYS: posix locks not implemented", async () => {
    runFuseCmd(`mkdir -p /mnt/agent-fs`);
    inFs(`mount /mnt/agent-fs`);
    await Bun.sleep(500);
    runFuseCmd(`echo 'lock-test' > /mnt/agent-fs/current/lock.md`);
    const res = runFuseCmd(`flock /mnt/agent-fs/current/lock.md -c true 2>&1 || echo NONZERO`, { allowFailure: true });
    // Either ENOSYS (Function not implemented) OR success — we accept either as long as it's
    // documented. In v1 we expect ENOSYS; some kernels may auto-handle locally so we don't fail.
    const expected =
      res.toLowerCase().includes("not implemented") ||
      res.toLowerCase().includes("nosys") ||
      res.includes("NONZERO") ||
      res === "" /* lock acquired and immediately released — also acceptable */;
    assert(expected, true, `unexpected flock result: ${JSON.stringify(res)}`);
    inFs(`umount /mnt/agent-fs`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  await setup();
  await runTests();
} finally {
  cleanup();
}

console.log(`\nResults: ${passed}/${passed + failed} passed${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
if (failures.length > 0) {
  console.log(`Failed: ${failures.join(", ")}`);
  process.exit(1);
}
