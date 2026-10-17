import OpenAI from "openai";
import type { EmbeddingProvider } from "./provider.js";

/**
 * OpenAI caps one embeddings request at 2,048 inputs and 300,000 tokens in
 * total. A large file is sent in several requests. Chunks are sized in
 * characters, and dense text (base64, minified JSON, CJK) can come close to
 * one token per character, so the token budget is counted in characters.
 */
const MAX_INPUTS_PER_REQUEST = 2048;
const MAX_CHARS_PER_REQUEST = 250_000;

/** Splits `texts` into consecutive groups within the request limits. */
export function requestBatches(
  texts: string[],
  limits = { inputs: MAX_INPUTS_PER_REQUEST, chars: MAX_CHARS_PER_REQUEST }
): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const text of texts) {
    if (batch.length > 0 && (batch.length === limits.inputs || chars + text.length > limits.chars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(text);
    chars += text.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = 768;
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embedQuery(text: string): Promise<number[]> {
    const result = await this.client.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 768,
    });
    return result.data[0].embedding;
  }

  async embedDocuments(texts: string[], _opts: { title: string }): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const batch of requestBatches(texts)) {
      const result = await this.client.embeddings.create({
        model: "text-embedding-3-small",
        input: batch,
        dimensions: 768,
      });
      vectors.push(...result.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return vectors;
  }
}
