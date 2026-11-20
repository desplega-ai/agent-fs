import { describe, expect, test } from "bun:test";
import { compareVersions, detectInstallMethod, updateCommandFor } from "../update.js";

describe("detectInstallMethod", () => {
  test.each([
    ["/Users/t/.bun/install/global/node_modules/@desplega.ai/agent-fs/dist/cli.js", "bun"],
    ["/opt/bun/install/global/node_modules/@desplega.ai/agent-fs/dist/cli.js", "bun"],
    ["/opt/homebrew/lib/node_modules/@desplega.ai/agent-fs/dist/cli.js", "npm"],
    ["/usr/local/lib/node_modules/@desplega.ai/agent-fs/dist/cli.js", "npm"],
    ["/Users/t/Library/pnpm/global/5/node_modules/@desplega.ai/agent-fs/dist/cli.js", "pnpm"],
    ["/home/t/.local/share/pnpm/global/5/.pnpm/@desplega.ai+agent-fs@0.18.35/node_modules/@desplega.ai/agent-fs/dist/cli.js", "pnpm"],
    ["/Users/t/.npm/_npx/abc123/node_modules/@desplega.ai/agent-fs/dist/cli.js", "npx"],
    ["/Users/t/code/agent-fs/packages/cli/dist/cli.js", "source"],
    ["C:\\Users\\t\\AppData\\Roaming\\npm\\node_modules\\@desplega.ai\\agent-fs\\dist\\cli.js", "npm"],
  ] as const)("%s -> %s", (path, method) => {
    expect(detectInstallMethod(path)).toBe(method);
  });
});

describe("updateCommandFor", () => {
  test("uses the installing package manager", () => {
    expect(updateCommandFor("bun", "1.2.3")).toEqual(["bun", "add", "-g", "@desplega.ai/agent-fs@1.2.3"]);
    expect(updateCommandFor("npm", "1.2.3")).toEqual(["npm", "install", "-g", "@desplega.ai/agent-fs@1.2.3"]);
    expect(updateCommandFor("pnpm", "1.2.3")).toEqual(["pnpm", "add", "-g", "@desplega.ai/agent-fs@1.2.3"]);
  });

  test("has no command for npx or a source checkout", () => {
    expect(updateCommandFor("npx", "1.2.3")).toBeNull();
    expect(updateCommandFor("source", "1.2.3")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("compares numerically, not as strings", () => {
    expect(compareVersions("0.18.9", "0.18.35")).toBe(-1);
    expect(compareVersions("0.18.35", "0.18.35")).toBe(0);
    expect(compareVersions("0.19.0", "0.18.35")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
  });
});
