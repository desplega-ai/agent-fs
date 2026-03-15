export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number; // always 768
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dispose?(): Promise<void>;
}
