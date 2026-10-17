import type { EmbeddingProvider } from "./provider.js";
import type { TransformersResult } from "./embeddinggemma.js";
import type { WorkerRequest, WorkerReply } from "./embeddinggemma-worker.js";

export interface RuntimeOptions {
  paths: { transformers?: string; unpdf?: string; canvas?: string };
  cacheDir: string;
  version: string;
  hint: string;
}

export interface WorkerScope {
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
  postMessage(message: WorkerReply): void;
}

export function embeddingGemmaSource(cacheDir: string, vision: boolean): string;
export class EmbeddingGemmaRuntime implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  constructor(options: RuntimeOptions, loadModule?: (path: string) => Promise<unknown>);
  scheduleIdle(run: () => Promise<void>): Promise<void>;
  probe(): Promise<TransformersResult>;
  loadCanvas(): Promise<unknown>;
  embedQuery: EmbeddingProvider["embedQuery"];
  embedDocuments: EmbeddingProvider["embedDocuments"];
  embedParts: NonNullable<EmbeddingProvider["embedParts"]>;
  renderPdfPages(bytes: Uint8Array, n: number): Promise<{ page: number; data: Uint8Array }[]>;
  dispose(): Promise<void>;
}
export function startWorker(scope: WorkerScope, runtime?: EmbeddingGemmaRuntime): void;
// The default string export exists only under an import with { type: "text" }.
declare const source: string;
export default source;
