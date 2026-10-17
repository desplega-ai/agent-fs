export interface EmbeddingPart {
  mime: string;
  data: Uint8Array;
}

/** The provider cannot initialize its model. Keep queued files pending. */
export class EmbeddingInitializationError extends Error {
  constructor(cause: unknown) {
    super(`Embedding model initialization failed: ${cause instanceof Error ? cause.message : cause}`, { cause });
    this.name = "EmbeddingInitializationError";
  }
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number; // always 768
  embedQuery(text: string): Promise<number[]>;
  /** `title` is the file basename. Providers that add no text prefix ignore it. */
  embedDocuments(texts: string[], opts: { title: string }): Promise<number[][]>;
  supportsMime?(mime: string): boolean;
  embedParts?(parts: EmbeddingPart[]): Promise<number[][]>;
  dispose?(): Promise<void>;
}
