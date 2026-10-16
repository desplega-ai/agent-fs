export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number; // always 768
  embedQuery(text: string): Promise<number[]>;
  /** `title` is the file basename. Providers that add no text prefix ignore it. */
  embedDocuments(texts: string[], opts: { title: string }): Promise<number[][]>;
  dispose?(): Promise<void>;
}
