import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestConfigDir } from "@/core/test-utils.js";
import { onboardCommand } from "../commands/onboard.js";

// A stand-in `docker` on PATH records every invocation (plus the MinIO root
// credentials it was handed through the environment), so the onboard wizard
// runs end to end without a Docker daemon.
let testHome: string;
let cleanup: () => void;
let dockerLog: string;
let savedPath: string | undefined;
let log: ReturnType<typeof spyOn>;

function installFakeDocker(existingContainer: boolean) {
  const bin = join(testHome, "fake-bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const script = join(bin, "docker");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `{ printf '%s' "$*"; [ -n "$MINIO_ROOT_PASSWORD" ] && printf ' env:MINIO_ROOT_USER=%s env:MINIO_ROOT_PASSWORD=%s' "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; echo; } >> '${dockerLog}'`,
      'case "$1" in',
      `  ps) ${existingContainer ? "echo agent-fs-minio" : "true"} ;;`,
      '  inspect) case "$*" in',
      "    *Env*) printf 'PATH=/usr/bin\\nMINIO_ROOT_USER=existing-user\\nMINIO_ROOT_PASSWORD=existing-password\\n' ;;",
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

    const run = dockerCalls().find((c) => c.startsWith("run "));
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

    const run = dockerCalls().find((c) => c.startsWith("run "))!;
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

    const run = dockerCalls().find((c) => c.startsWith("run "))!;
    const password = run.match(/MINIO_ROOT_PASSWORD=(\S+)/)?.[1];
    expect(password).toBeDefined();
    expect(password).not.toBe("minioadmin");
    expect(password!.length).toBeGreaterThanOrEqual(32);
  },
  15000
);

test(
  "an existing MinIO container is reused with its own credentials",
  async () => {
    installFakeDocker(true);
    await runOnboard();

    const calls = dockerCalls();
    expect(calls.some((c) => c.startsWith("run "))).toBe(false);
    expect(calls).toContain("start agent-fs-minio");
    const s3 = readS3Config();
    expect(s3.accessKeyId).toBe("existing-user");
    expect(s3.secretAccessKey).toBe("existing-password");
  },
  15000
);
