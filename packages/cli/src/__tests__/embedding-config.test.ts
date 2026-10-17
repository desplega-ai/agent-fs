import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestConfigDir } from "@/core/test-utils.js";
import { configCommands } from "../commands/config-cmd.js";
import { onboardCommand } from "../commands/onboard.js";

let testHome: string;
let cleanup: () => void;
let log: ReturnType<typeof spyOn>;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  ({ dir: testHome, cleanup } = createTestConfigDir());
  savedEnv = {};
  for (const key of ["EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_API_KEY"]) {
    savedEnv[key] = process.env[key];
    process.env[key] = "";
  }
  writeFileSync(join(testHome, "config.json"), JSON.stringify({
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "openai-key" },
  }));
  log = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  cleanup();
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value ?? "";
});

test("config set removes the previous provider fields and prints one notice", async () => {
  process.env.EMBEDDING_PROVIDER = "gemini";
  await configCommands().parseAsync(["set", "embedding.provider", "openai"], { from: "user" });
  expect(JSON.parse(readFileSync(join(testHome, "config.json"), "utf-8")).embedding.apiKey).toBe("openai-key");
  expect(log.mock.calls).toHaveLength(1);
  log.mockClear();

  await configCommands().parseAsync(["set", "embedding.provider", "gemini"], { from: "user" });
  expect(JSON.parse(readFileSync(join(testHome, "config.json"), "utf-8")).embedding).toEqual({ provider: "gemini", model: "", apiKey: "" });
  expect(log.mock.calls).toEqual([
    ["Removed embedding.model and embedding.apiKey for the previous provider."],
    ['Set embedding.provider = "gemini"'],
  ]);
});

test.each([
  ["local", ""],
  ["none", ""],
  ["gemini", "text-embedding-004"],
  ["openai", "text-embedding-3-small"],
])("onboard %s leaves a consistent model and key", async (provider, model) => {
  await onboardCommand().parseAsync([
    "--filesystem", "--yes", "--no-daemon", "--embeddings", provider,
  ], { from: "user" });
  const embedding = JSON.parse(readFileSync(join(testHome, "config.json"), "utf-8")).embedding;
  expect(embedding.provider).toBe(provider === "none" ? "local" : provider);
  expect(embedding.model).toBe(model);
  expect(embedding.apiKey || "").toBe(provider === "openai" ? "openai-key" : "");
});

test("config set prints no removal notice when the previous provider fields are empty", async () => {
  writeFileSync(join(testHome, "config.json"), JSON.stringify({
    embedding: { provider: "openai", model: "", apiKey: "" },
  }));
  await configCommands().parseAsync(["set", "embedding.provider", "local"], { from: "user" });
  expect(log.mock.calls).toEqual([['Set embedding.provider = "local"']]);
});

test("onboard local preserves an explicit local model", async () => {
  writeFileSync(join(testHome, "config.json"), JSON.stringify({
    embedding: { provider: "local", model: "embeddinggemma-2", apiKey: "" },
  }));
  await onboardCommand().parseAsync([
    "--filesystem", "--yes", "--no-daemon", "--embeddings", "local",
  ], { from: "user" });
  expect(JSON.parse(readFileSync(join(testHome, "config.json"), "utf-8")).embedding).toEqual({
    provider: "local", model: "embeddinggemma-2", apiKey: "",
  });
});
