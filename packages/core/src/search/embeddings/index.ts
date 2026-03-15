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
