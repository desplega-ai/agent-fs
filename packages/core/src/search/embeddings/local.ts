import type { EmbeddingProvider } from "./provider.js";
import { getAgentFSHome } from "../../config.js";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

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
    const { getLlama } = await import("node-llama-cpp");
    this.llama = await getLlama();

    const modelsDir = join(getAgentFSHome(), "models");
    if (!existsSync(modelsDir)) {
      mkdirSync(modelsDir, { recursive: true });
    }

    const modelPath = join(modelsDir, "embeddinggemma-300m-Q8_0.gguf");

    if (!existsSync(modelPath)) {
      // Auto-download from HuggingFace
      console.log("Downloading embeddinggemma-300M model (~329MB)...");
      const response = await fetch(
        "https://huggingface.co/nicoboss/EmbeddingGemma-300M-Q8_0-GGUF/resolve/main/embeddinggemma-300m-q8_0.gguf"
      );
      if (!response.ok) {
        throw new Error(`Failed to download model: ${response.statusText}`);
      }
      const data = await response.arrayBuffer();
      await Bun.write(modelPath, data);
      console.log("Model downloaded successfully.");
    }

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
