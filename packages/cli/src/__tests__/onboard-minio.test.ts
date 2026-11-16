import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestConfigDir } from "@/core/test-utils.js";
import { MINIO_IMAGE, onboardCommand } from "../commands/onboard.js";

// A stand-in `docker` on PATH records every invocation (plus the MinIO root
// credentials it was handed through the environment), so the onboard wizard
// runs end to end without a Docker daemon.
let testHome: string;
let cleanup: () => void;
let dockerLog: string;
let savedPath: string | undefined;
let log: ReturnType<typeof spyOn>;

// The volume starts root-owned when `rootOwnedVolume` (left by an earlier
// minio/minio install): the uid-1001 container then dies at start unless a
// chown ran first. `alwaysDies` makes it die regardless.
function installFakeDocker(
  existingContainer: boolean,
  { rootOwnedVolume = false, alwaysDies = false, existingImage = "minio/minio" } = {}
) {
  const bin = join(testHome, "fake-bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const script = join(bin, "docker");
  const owned = join(testHome, "volume-owned");
  const dead = join(testHome, "container-dead");
  if (!rootOwnedVolume) writeFileSync(owned, "");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `{ printf '%s' "$*"; [ -n "$MINIO_ROOT_PASSWORD" ] && printf ' env:MINIO_ROOT_USER=%s env:MINIO_ROOT_PASSWORD=%s' "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; echo; } >> '${dockerLog}'`,
      'case "$1" in',
      `  ps) ${existingContainer ? "echo agent-fs-minio" : "true"} ;;`,
      `  start) [ -f '${owned}' ] || touch '${dead}' ;;`,
      '  run) case "$*" in',
      `    *"--entrypoint chown"*"-R 1001 /bitnami/minio/data") touch '${owned}' ;;`,
      `    *) { [ -f '${owned}' ] && [ ${alwaysDies ? 1 : 0} = 0 ]; } || touch '${dead}' ;;`,
      "  esac ;;",
      `  exec) [ ! -f '${dead}' ] || exit 1 ;;`,
      `  logs) echo "mkdir: cannot create directory '/bitnami/minio/data/.minio.sys': Permission denied" ;;`,
      '  inspect) case "$*" in',
      "    *Env*) printf 'PATH=/usr/bin\\nMINIO_ROOT_USER=existing-user\\nMINIO_ROOT_PASSWORD=existing-password\\n' ;;",
      `    *Config.Image*) echo '${existingImage}' ;;`,
      `    *State.Running*) if [ -f '${dead}' ]; then echo false; else echo true; fi ;;`,
      "    *) echo fake-container-id ;;",
      "  esac ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(script, 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
}

function dockerCalls(): string[] {
  return existsSync(dockerLog) ? readFileSync(dockerLog, "utf-8").trim().split("\n") : [];
}

function readS3Config() {
  return JSON.parse(readFileSync(join(testHome, "config.json"), "utf-8")).s3;
}

// Onboard waits for MinIO's health endpoint on the published loopback port.
let minioHealth: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  minioHealth = Bun.serve({
    hostname: "127.0.0.1",
    port: 9000,
    fetch: (req) =>
      new Response(null, {
        status: new URL(req.url).pathname === "/minio/health/live" ? 200 : 404,
      }),
  });
});
afterAll(() => minioHealth.stop(true));

beforeEach(() => {
  ({ dir: testHome, cleanup } = createTestConfigDir());
  dockerLog = join(testHome, "docker-calls.log");
  savedPath = process.env.PATH;
  log = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  process.env.PATH = savedPath;
  cleanup();
});

async function runOnboard() {
  await onboardCommand().parseAsync(["--yes", "--no-daemon"], { from: "user" });
}

test(
  "default onboard creates the MinIO container and stores matching credentials",
  async () => {
    installFakeDocker(false);
    await runOnboard();

    const run = dockerCalls().find((c) => c.startsWith("run -d "));
    expect(run).toBeDefined();
    expect(run).toContain("--name agent-fs-minio");

    const user = run!.match(/MINIO_ROOT_USER=(\S+)/)?.[1];
    const password = run!.match(/MINIO_ROOT_PASSWORD=(\S+)/)?.[1];
    const s3 = readS3Config();
    expect(s3.provider).toBe("minio");
    expect(s3.endpoint).toBe("http://localhost:9000");
    expect(s3.accessKeyId).toBe(user);
    expect(s3.secretAccessKey).toBe(password);
  },
  15000
);

test(
  "MinIO ports are published on loopback only",
  async () => {
    installFakeDocker(false);
    await runOnboard();

    const run = dockerCalls().find((c) => c.startsWith("run -d "))!;
    const mappings = [...run.matchAll(/-p (\S+)/g)].map((m) => m[1]);
    expect(mappings.length).toBeGreaterThan(0);
    for (const mapping of mappings) {
      expect(mapping.startsWith("127.0.0.1:")).toBe(true);
    }
  },
  15000
);

test(
  "a new MinIO container does not use the stock root password",
  async () => {
    installFakeDocker(false);
    await runOnboard();

    const run = dockerCalls().find((c) => c.startsWith("run -d "))!;
    const password = run.match(/MINIO_ROOT_PASSWORD=(\S+)/)?.[1];
    expect(password).toBeDefined();
    expect(password).not.toBe("minioadmin");
    expect(password!.length).toBeGreaterThanOrEqual(32);
  },
  15000
);

test(
  "a new MinIO container uses the pullable image pinned in docker-compose.yml",
  async () => {
    installFakeDocker(false);
    await runOnboard();

    const run = dockerCalls().find((c) => c.startsWith("run -d "))!;
    const compose = readFileSync(join(import.meta.dir, "../../../../docker-compose.yml"), "utf-8");
    expect(compose).toContain(`image: ${MINIO_IMAGE}`);
    // The image's own entrypoint starts the server; a command override such
    // as minio/minio's `server /data` would bypass it.
    expect(run.split(" env:")[0].endsWith(` ${MINIO_IMAGE}`)).toBe(true);
    expect(run).not.toContain("minio/minio");
    expect(run).toContain("-v agent-fs-minio-data:/bitnami/minio/data");
    expect(run).toContain("-e MINIO_DEFAULT_BUCKETS=agentfs");
  },
  15000
);

test(
  "an existing MinIO container is reused with its own credentials",
  async () => {
    installFakeDocker(true);
    await runOnboard();

    const calls = dockerCalls();
    expect(calls.some((c) => c.startsWith("run -d "))).toBe(false);
    expect(calls).toContain("start agent-fs-minio");
    const s3 = readS3Config();
    expect(s3.accessKeyId).toBe("existing-user");
    expect(s3.secretAccessKey).toBe("existing-password");
  },
  15000
);

test(
  "a leftover root-owned data volume is handed to the MinIO uid before the first start",
  async () => {
    installFakeDocker(false, { rootOwnedVolume: true });
    await runOnboard();

    const calls = dockerCalls();
    const chown = calls.findIndex((c) => c.includes("--entrypoint chown"));
    const start = calls.findIndex((c) => c.startsWith("run -d "));
    expect(chown).toBeGreaterThanOrEqual(0);
    expect(calls[chown]).toContain("--user 0");
    expect(calls[chown]).toContain("-v agent-fs-minio-data:/bitnami/minio/data");
    expect(chown).toBeLessThan(start);
    expect(readS3Config().provider).toBe("minio");
  },
  15000
);

test(
  "onboard fails with the container logs when MinIO is not running",
  async () => {
    installFakeDocker(false, { alwaysDies: true });
    const error = spyOn(console, "error").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    try {
      await expect(runOnboard()).rejects.toThrow("exit 1");
      const message = error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(message).toContain("MinIO container agent-fs-minio is not running");
      expect(message).toContain("Permission denied");
      const configured = existsSync(join(testHome, "config.json")) && readS3Config()?.provider;
      expect(configured).not.toBe("minio");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  },
  15000
);

test(
  "an existing container on the pinned image gets its volume handed over before it starts",
  async () => {
    installFakeDocker(true, { rootOwnedVolume: true, existingImage: MINIO_IMAGE });
    await runOnboard();

    const calls = dockerCalls();
    const chown = calls.findIndex((c) => c.includes("--entrypoint chown"));
    expect(chown).toBeGreaterThanOrEqual(0);
    expect(chown).toBeLessThan(calls.indexOf("start agent-fs-minio"));
    expect(readS3Config().provider).toBe("minio");
  },
  15000
);
