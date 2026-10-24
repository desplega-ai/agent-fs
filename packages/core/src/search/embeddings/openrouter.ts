import OpenAI from "openai";
import { EmbeddingProviderError } from "../../errors.js";
import { toUnitVector } from "../vectors.js";
import { requestBatches } from "./openai.js";
import type { EmbeddingProvider } from "./provider.js";

export const DEFAULT_OPENROUTER_MODEL = "openai/text-embedding-3-small";

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions = 768;
  private client: OpenAI;

  constructor(apiKey: string, private readonly model = DEFAULT_OPENROUTER_MODEL) {
    // The existing migration compares provider names. A model change must rebuild vectors too.
    this.name = `openrouter/${model}`;
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      timeout: 30_000,
    });
  }

  private async embed(input: string | string[]): Promise<number[][]> {
    let result: OpenAI.CreateEmbeddingResponse;
    try {
      result = await this.client.embeddings.create({
        model: this.model,
        input,
        dimensions: this.dimensions,
        encoding_format: "float",
      });
    } catch (error) {
      // Provider response bodies can contain credentials or document text.
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      throw new EmbeddingProviderError(
        `OpenRouter embedding request failed${status ? ` (HTTP ${status})` : ""}. Check the API key, model, account balance, and connectivity.`
      );
    }
    const count = typeof input === "string" ? 1 : input.length;
    if (!Array.isArray(result.data) || result.data.length !== count) {
      throw new EmbeddingProviderError(`OpenRouter must return ${count} embeddings`);
    }
    return result.data.sort((a, b) => a.index - b.index).map((item, index) => {
      if (item.index !== index || !Array.isArray(item.embedding)) {
        throw new EmbeddingProviderError("OpenRouter returned an invalid embedding or index");
      }
      // Validate during boot warmup too, before migration changes the stored format.
      return Array.from(toUnitVector(item.embedding, this.dimensions));
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embed(text))[0];
  }

  async embedDocuments(texts: string[], _opts: { title: string }): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const batch of requestBatches(texts)) {
      vectors.push(...await this.embed(batch));
    }
    return vectors;
  }
}
