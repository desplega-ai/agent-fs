import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmbeddingPart, EmbeddingProvider } from "./provider.js";
import { embeddingGemmaWorker, type EmbeddingGemmaWorker } from "./embeddinggemma-worker.js";

export const TRANSFORMERS_VERSION = "4.3.1";
export const INSTALL_HINT = `Run: bun add -g @huggingface/transformers@${TRANSFORMERS_VERSION}`;

export type TransformersResult = { module: true } | { reason: string; hint: string };

export function linuxRuntimeConflict(platform: string, chonkieVersion?: string): string | null {
  if (platform !== "linux" || !chonkieVersion || chonkieVersion === TRANSFORMERS_VERSION) return null;
  return `chonkie loads @huggingface/transformers ${chonkieVersion}, and two ONNX runtimes cannot run in one Linux process. Use the Docker image`;
}

function packageVersion(path: string): string {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    } catch (err: any) {
      if (err.code !== "ENOENT" || dirname(dir) === dir) throw err;
    }
  }
}

export function transformersRuntimeConflict(): string | null {
  if (process.platform !== "linux") return null;
  let chonkie: string;
  try {
    chonkie = Bun.resolveSync("chonkie", import.meta.dir);
  } catch {
    return null;
  }
  const path = Bun.resolveSync("@huggingface/transformers", dirname(chonkie));
  return linuxRuntimeConflict(process.platform, packageVersion(path));
}

export async function loadTransformers(): Promise<TransformersResult> {
  try {
    Bun.resolveSync("@huggingface/transformers", import.meta.dir);
    return await embeddingGemmaWorker.call("probe", {});
  } catch (err) {
    return { reason: `missing (@huggingface/transformers: ${err instanceof Error ? err.message : err})`, hint: INSTALL_HINT };
  }
}

export class EmbeddingGemmaProvider implements EmbeddingProvider {
  readonly name = "embeddinggemma";
  readonly dimensions = 768;

  constructor(private worker: EmbeddingGemmaWorker = embeddingGemmaWorker) {}

  embedQuery(text: string): Promise<number[]> {
    return this.worker.call("query", { text });
  }

  async embedDocuments(texts: string[], { title }: { title: string }): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) results.push(await this.worker.call("document", { text, title }));
    return results;
  }

  supportsMime(mime: string): boolean {
    return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
  }

  async embedParts(parts: EmbeddingPart[]): Promise<number[][]> {
    for (const part of parts) {
      if (!this.supportsMime(part.mime)) throw new Error(`Unsupported embedding MIME type: ${part.mime}`);
    }
    const results: number[][] = [];
    for (const part of parts) results.push(await this.worker.call("image", { part }));
    return results;
  }

  async dispose(): Promise<void> {
    await this.worker.dispose();
  }
}
