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
 * Auto-detect and create an embedding provider from environment variables,
 * falling back to config file settings. Returns null if no provider can be configured.
 *
 * Priority: env var (OPENAI_API_KEY, GEMINI_API_KEY) > config file > null
 */
export async function createEmbeddingProviderFromEnv(
  config?: AgentFSConfig["embedding"]
): Promise<EmbeddingProvider | null> {
  // 1. Check env vars first
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
