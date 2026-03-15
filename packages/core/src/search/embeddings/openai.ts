import OpenAI from "openai";
import type { EmbeddingProvider } from "./provider.js";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = 768;
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.client.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 768,
    });
    return result.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const result = await this.client.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
      dimensions: 768,
    });
    return result.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
