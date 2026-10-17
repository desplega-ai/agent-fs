import type { EmbeddingProvider } from "./provider.js";
import type { AgentFSConfig } from "../../config.js";

export type { EmbeddingProvider } from "./provider.js";

export async function createEmbeddingProvider(
  config: AgentFSConfig["embedding"]
): Promise<EmbeddingProvider> {
  switch (config.provider) {
    case "local": {
      const { LocalEmbeddingProvider } = await import("./local.js");
      return new LocalEmbeddingProvider();
    }
    case "openai": {
      if (!config.apiKey) {
        throw new Error("OpenAI API key required. Set embedding.apiKey in config.");
      }
      const { OpenAIEmbeddingProvider } = await import("./openai.js");
      return new OpenAIEmbeddingProvider(config.apiKey);
    }
    case "gemini": {
      if (!config.apiKey) {
        throw new Error("Gemini API key required. Set embedding.apiKey in config.");
      }
      const { GeminiEmbeddingProvider } = await import("./gemini.js");
      return new GeminiEmbeddingProvider(config.apiKey);
    }
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}

/**
 * Create the explicit EMBEDDING_PROVIDER first, using config.apiKey or its provider's env key.
 * Return null if the explicit provider cannot be configured.
 *
 * Without EMBEDDING_PROVIDER, try OPENAI_API_KEY, GEMINI_API_KEY, then config settings.
 */
export async function createEmbeddingProviderFromEnv(
  config?: AgentFSConfig["embedding"]
): Promise<EmbeddingProvider | null> {
  const explicit = process.env.EMBEDDING_PROVIDER;
  if (explicit) {
    const envKeys: Record<string, string | undefined> = {
      openai: process.env.OPENAI_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
    };
    try {
      return await createEmbeddingProvider({
        provider: explicit as AgentFSConfig["embedding"]["provider"],
        model: config?.model ?? "",
        apiKey: config?.apiKey || envKeys[explicit] || "",
      });
    } catch (e) {
      console.error(`[agent-fs] EMBEDDING_PROVIDER=${explicit} unavailable: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  // 1. Without an explicit provider, API key env vars come first
  if (process.env.OPENAI_API_KEY) {
    try {
      const { OpenAIEmbeddingProvider } = await import("./openai.js");
      return new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY);
    } catch (e) {
      console.error("[agent-fs] Failed to load OpenAI provider:", e);
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const { GeminiEmbeddingProvider } = await import("./gemini.js");
      return new GeminiEmbeddingProvider(process.env.GEMINI_API_KEY);
    } catch (e) {
      console.error("[agent-fs] Failed to load Gemini provider:", e);
    }
  }

  // 2. Fall back to config file
  if (config?.provider && config.provider !== "local" && config.apiKey) {
    try {
      return await createEmbeddingProvider(config);
    } catch (e) {
      console.error("[agent-fs] Failed to create embedding provider from config:", e);
    }
  }

  // 3. Try local provider from config
  if (config?.provider === "local") {
    try {
      return await createEmbeddingProvider(config);
    } catch (e) {
      console.error("[agent-fs] Failed to load local embedding provider:", e);
    }
  }

  return null;
}
