import { GoogleGenAI } from "@google/genai";
import type { EmbeddingProvider } from "./provider.js";

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly dimensions = 768;
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.client.models.embedContent({
      model: "gemini-embedding-001",
      contents: text,
      config: { outputDimensionality: 768 },
    });
    return result.embeddings![0].values!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Gemini supports batch via multiple contents
    const results: number[][] = [];
    for (const text of texts) {
      const result = await this.client.models.embedContent({
        model: "gemini-embedding-001",
        contents: text,
        config: { outputDimensionality: 768 },
      });
      results.push(result.embeddings![0].values!);
    }
    return results;
  }
}
