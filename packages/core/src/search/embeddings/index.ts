import type { EmbeddingProvider } from "./provider.js";
import type { AgentFSConfig } from "../../config.js";
import type { TransformersResult } from "./embeddinggemma.js";

export const NOMIC_MODEL = "nomic-embed-text-v1.5";
export const EMBEDDINGGEMMA_MODEL = "embeddinggemma-2";

export type { EmbeddingProvider } from "./provider.js";

export async function resolveLocalModel({ configured, storedFormat, hasChunks, loadTransformers }: {
  configured?: string;
  storedFormat?: string;
  hasChunks: boolean;
  loadTransformers: () => Promise<TransformersResult>;
}): Promise<{ model: string; reason: string; transformers?: TransformersResult }> {
  if (configured) return { model: configured, reason: "configured" };
  if (hasChunks && (storedFormat == null || storedFormat.startsWith("local:"))) {
    return { model: NOMIC_MODEL, reason: "index built by nomic" };
  }
  const transformers = await loadTransformers();
  const reason = storedFormat?.startsWith("embeddinggemma:")
    ? "index built by embeddinggemma-2"
    : hasChunks ? "index built by another provider" : "fresh index";
  const available = "module" in transformers;
  return {
    model: available || storedFormat?.startsWith("embeddinggemma:") ? EMBEDDINGGEMMA_MODEL : NOMIC_MODEL,
    reason: available ? reason : `${reason}, transformers unavailable: ${transformers.reason}`.replace(/[\r\n]+/g, " "),
    transformers,
  };
}

interface LocalIndex {
  storedFormat?: string;
  hasChunks: boolean;
  loadTransformers?: () => Promise<TransformersResult>;
  log?: (message: string) => void;
}

async function resolveLocalProvider(configured: string, index?: LocalIndex) {
  if (!index) return { model: configured, transformers: undefined };
  const { model, reason, transformers } = await resolveLocalModel({
    configured,
    ...index,
    loadTransformers: index.loadTransformers ?? (async () => {
      const { loadTransformers } = await import("./embeddinggemma.js");
      return loadTransformers();
    }),
  });
  index.log?.(`[agent-fs] local embedding model: ${model} (${reason})`);
  if (transformers && "hint" in transformers && transformers.hint) index.log?.(transformers.hint);
  return { model, transformers };
}

export async function createEmbeddingProvider(
  config: AgentFSConfig["embedding"],
  localIndex?: LocalIndex,
): Promise<EmbeddingProvider> {
  switch (config.provider) {
    case "local": {
      const { model } = await resolveLocalProvider(config.model, localIndex);
      if (model === EMBEDDINGGEMMA_MODEL) {
        const { EmbeddingGemmaProvider } = await import("./embeddinggemma.js");
        return new EmbeddingGemmaProvider();
      }
      if (model && model !== NOMIC_MODEL) {
        throw new Error(`Unknown local embedding model: ${model}. Use nomic-embed-text-v1.5 or embeddinggemma-2.`);
      }
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
    case "openrouter": {
      if (!config.apiKey) {
        throw new Error("OpenRouter API key required. Set embedding.apiKey in config or OPENROUTER_API_KEY with EMBEDDING_PROVIDER=openrouter.");
      }
      const { OpenRouterEmbeddingProvider } = await import("./openrouter.js");
      return new OpenRouterEmbeddingProvider(config.apiKey, config.model || undefined);
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
  config?: AgentFSConfig["embedding"],
  localIndex?: LocalIndex,
): Promise<EmbeddingProvider | null> {
  const explicit = process.env.EMBEDDING_PROVIDER;
  if (explicit) {
    const envKeys: Record<string, string | undefined> = {
      openai: process.env.OPENAI_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
    };
    try {
      return await createEmbeddingProvider({
        provider: explicit as AgentFSConfig["embedding"]["provider"],
        model: config?.model ?? "",
        apiKey: config?.apiKey || envKeys[explicit] || "",
      }, localIndex);
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
  const configKey = config?.apiKey || (config?.provider === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined);
  if (config?.provider && config.provider !== "local" && configKey) {
    try {
      return await createEmbeddingProvider({ ...config, apiKey: configKey }, localIndex);
    } catch (e) {
      console.error("[agent-fs] Failed to create embedding provider from config:", e);
    }
  }

  // 3. Try local provider from config
  if (config?.provider === "local") {
    try {
      return await createEmbeddingProvider(config, localIndex);
    } catch (e) {
      console.error(`[agent-fs] Failed to load local embedding provider: ${e instanceof Error ? e.message : e}`);
    }
  }

  return null;
}
