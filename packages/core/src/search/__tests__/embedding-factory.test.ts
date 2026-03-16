import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createEmbeddingProviderFromEnv } from "../embeddings/index.js";

describe("createEmbeddingProviderFromEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear embedding-related env vars
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    // Restore original env
    process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = originalEnv.GEMINI_API_KEY;
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
});
