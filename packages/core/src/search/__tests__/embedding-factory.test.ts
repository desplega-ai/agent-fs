import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingProviderFromEnv } from "../embeddings/index.js";
import { OpenAIEmbeddingProvider } from "../embeddings/openai.js";
import { GeminiEmbeddingProvider } from "../embeddings/gemini.js";
import { embeddingFormat } from "../embedding-migration.js";
import { getConfig } from "../../config.js";

describe("createEmbeddingProviderFromEnv", () => {
  const envKeys = [
    "AGENT_FS_HOME",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ] as const;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test("returns null when no env vars or config", async () => {
    const provider = await createEmbeddingProviderFromEnv();
    expect(provider).toBeNull();
  });

  test("returns null when config has no apiKey for non-local provider", async () => {
    const provider = await createEmbeddingProviderFromEnv({
      provider: "openai",
      model: "",
      apiKey: "",
    });
    expect(provider).toBeNull();
  });

  test("returns OpenAI provider when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const provider = await createEmbeddingProviderFromEnv();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("openai");
  });

  test("returns Gemini provider when GEMINI_API_KEY is set", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const provider = await createEmbeddingProviderFromEnv();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
  });

  test("env var takes priority over config", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const provider = await createEmbeddingProviderFromEnv({
      provider: "gemini",
      model: "",
      apiKey: "gemini-key",
    });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("openai");
  });

  test("explicit local overrides OPENAI_API_KEY without loading the model", async () => {
    process.env.EMBEDDING_PROVIDER = "local";
    process.env.OPENAI_API_KEY = "sk-test-key";
    const provider = await createEmbeddingProviderFromEnv();
    expect(provider!.name).toBe("local");
    expect(embeddingFormat(provider!)).toBe("local:v3");
  });

  test("explicit gemini overrides OPENAI_API_KEY", async () => {
    process.env.EMBEDDING_PROVIDER = "gemini";
    process.env.OPENAI_API_KEY = "sk-test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    const provider = await createEmbeddingProviderFromEnv();
    expect(provider!.name).toBe("gemini");
    expect(embeddingFormat(provider!)).toBe("gemini:v2");
  });

  test("explicit openai uses EMBEDDING_API_KEY through getConfig (the prod setup)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-fs-factory-"));
    try {
      process.env.AGENT_FS_HOME = home;
      process.env.EMBEDDING_PROVIDER = "openai";
      process.env.EMBEDDING_API_KEY = "sk-embedding-key";
      const provider = await createEmbeddingProviderFromEnv(getConfig().embedding);
      expect(provider!.name).toBe("openai");
      expect(provider).toMatchObject({ client: { apiKey: "sk-embedding-key" } });
      expect(embeddingFormat(provider!)).toBe("openai:v2");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("explicit openai uses a config-only key", async () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    const provider = await createEmbeddingProviderFromEnv({
      provider: "openai",
      model: "",
      apiKey: "sk-config-key",
    });
    expect(provider!.name).toBe("openai");
  });

  test.each(["openai", "gemini"] as const)("explicit %s uses config.apiKey before its own env key", async (providerName) => {
    process.env.EMBEDDING_PROVIDER = providerName;
    process.env.OPENAI_API_KEY = "sk-env-key";
    process.env.GEMINI_API_KEY = "gemini-env-key";
    const provider = await createEmbeddingProviderFromEnv({
      provider: providerName,
      model: "",
      apiKey: "config-key",
    });
    expect(provider!.name).toBe(providerName);
    expect(provider).toMatchObject({ client: { apiKey: "config-key" } });
  });

  test("explicit openai without a key logs once and returns null", async () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await createEmbeddingProviderFromEnv()).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        "[agent-fs] EMBEDDING_PROVIDER=openai unavailable: OpenAI API key required. Set embedding.apiKey in config."
      );
    } finally {
      error.mockRestore();
    }
  });

  test("an empty provider preserves API key precedence", async () => {
    process.env.EMBEDDING_PROVIDER = "";
    process.env.OPENAI_API_KEY = "sk-test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    expect((await createEmbeddingProviderFromEnv())!.name).toBe("openai");
  });
});

describe("provider request inputs", () => {
  const query = "  Query\nwith Unicode: café  ";
  const texts = ["  First document\n", "Second document: café  "];

  test("OpenAI sends raw query and document text", async () => {
    const provider = new OpenAIEmbeddingProvider("sk-test-key");
    const create = mock(async (_request: unknown) => ({ data: [{ index: 0, embedding: [3, 4] }] }));
    Object.assign(provider, { client: { embeddings: { create } } });

    expect(await provider.embedQuery(query)).toEqual([3, 4]);
    expect(await provider.embedDocuments(texts, { title: "file.md" })).toEqual([[3, 4]]);
    expect(create.mock.calls).toEqual([
      [{ model: "text-embedding-3-small", input: query, dimensions: 768 }],
      [{ model: "text-embedding-3-small", input: texts, dimensions: 768 }],
    ]);
  });

  test("Gemini sends raw query and document text", async () => {
    const provider = new GeminiEmbeddingProvider("gemini-test-key");
    const embedContent = mock(async (_request: unknown) => ({ embeddings: [{ values: [3, 4] }] }));
    Object.assign(provider, { client: { models: { embedContent } } });

    expect(await provider.embedQuery(query)).toEqual([3, 4]);
    expect(await provider.embedDocuments(texts, { title: "file.md" })).toEqual([[3, 4], [3, 4]]);
    expect(embedContent.mock.calls).toEqual([query, ...texts].map((contents) => [{
      model: "gemini-embedding-001",
      contents,
      config: { outputDimensionality: 768 },
    }]));
  });
});
