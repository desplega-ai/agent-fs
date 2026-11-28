import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { ApiClient } from "../../api-client.js";
import { downloadCommand, resolveDownloadTarget } from "../download.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-fs-download-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const client = {
  getRaw: async () => ({ bytes: new TextEncoder().encode("hello"), contentType: "text/plain", version: 1, contentHash: "h" }),
} as unknown as ApiClient;

async function run(args: string[]) {
  const program = new Command().option("--json");
  program.addCommand(downloadCommand(client, () => "org", () => "drive"));
  const log = console.log;
  console.log = () => {};
  try {
    await program.parseAsync(["download", ...args], { from: "user" });
  } finally {
    console.log = log;
  }
}

describe("download target", () => {
  test("a new path is the file to write", () => {
    expect(resolveDownloadTarget("/docs/a.md", join(dir, "b.md"))).toBe(join(dir, "b.md"));
  });

  test("an existing directory gets the remote file's name", () => {
    expect(resolveDownloadTarget("/docs/a.md", dir)).toBe(join(dir, "a.md"));
  });

  test("the second argument writes the file", async () => {
    await run(["/docs/a.md", join(dir, "out.md")]);
    expect(readFileSync(join(dir, "out.md"), "utf-8")).toBe("hello");
  });

  test("-o still writes the file", async () => {
    await run(["/docs/a.md", "-o", join(dir, "out.md")]);
    expect(readFileSync(join(dir, "out.md"), "utf-8")).toBe("hello");
  });

  test("a directory target keeps the remote name", async () => {
    await run(["/docs/a.md", dir]);
    expect(readFileSync(join(dir, "a.md"), "utf-8")).toBe("hello");
  });
});
