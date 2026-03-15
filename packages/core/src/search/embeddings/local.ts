import type { EmbeddingProvider } from "./provider.js";
import { getAgentFSHome } from "../../config.js";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

// nomic-embed-text-v1.5: 768 dimensions, MIT license, publicly available
const MODEL_URI = "hf:nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0";

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimensions = 768;

  private llama: any = null;
  private model: any = null;
  private embeddingContext: any = null;
  private initPromise: Promise<void> | null = null;

  private async init(): Promise<void> {
    if (this.embeddingContext) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    const { getLlama, resolveModelFile } = await import("node-llama-cpp");
    this.llama = await getLlama();

    const modelsDir = join(getAgentFSHome(), "models");
    if (!existsSync(modelsDir)) {
      mkdirSync(modelsDir, { recursive: true });
    }

    // resolveModelFile handles download + caching automatically
    console.error("[agent-fs] Resolving local embedding model...");
    const modelPath = await resolveModelFile(MODEL_URI, modelsDir);
    console.error("[agent-fs] Model ready:", modelPath);

    this.model = await this.llama.loadModel({ modelPath });
    this.embeddingContext = await this.model.createEmbeddingContext();
  }

  async embed(text: string): Promise<number[]> {
    await this.init();
    const result = await this.embeddingContext.getEmbeddingFor(text);
    return Array.from(result.vector);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.init();
    const results: number[][] = [];
    for (const text of texts) {
      const result = await this.embeddingContext.getEmbeddingFor(text);
      results.push(Array.from(result.vector));
    }
    return results;
  }

  async dispose(): Promise<void> {
    if (this.embeddingContext) {
      await this.embeddingContext.dispose();
      this.embeddingContext = null;
    }
    if (this.model) {
      await this.model.dispose();
      this.model = null;
    }
    this.initPromise = null;
  }
}
