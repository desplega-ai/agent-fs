import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHome } from "../../config.js";
import { EmbeddingProviderError } from "../../errors.js";
import type { EmbeddingProvider } from "./provider.js";

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
const TRANSFORMERS_VERSION = "4.3.1";
const INSTALL_HINT = `Run: bun add -g @huggingface/transformers@${TRANSFORMERS_VERSION}`;
const MAX_TOKENS = 8192;

// The files a text-only q8 load by model id writes into the cache directory.
const TEXT_MODEL_FILES = [
  "config.json",
  "preprocessor_config.json",
  "processor_config.json",
  "tokenizer_config.json",
  "tokenizer.json",
  "chat_template.jinja",
  "onnx/model_quantized.onnx",
  "onnx/model_quantized.onnx_data",
];

type TransformersResult =
  | { module: typeof import("@huggingface/transformers") }
  | { reason: string; hint: string };

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

export async function loadTransformers(): Promise<TransformersResult> {
  try {
    if (process.platform === "linux") {
      let chonkie: string | undefined;
      try {
        chonkie = Bun.resolveSync("chonkie", import.meta.dir);
      } catch {}
      if (chonkie) {
        const path = Bun.resolveSync("@huggingface/transformers", dirname(chonkie));
        const reason = linuxRuntimeConflict(process.platform, packageVersion(path));
        if (reason) return { reason, hint: "" };
      }
    }
    const mod = await import("@huggingface/transformers");
    if (mod.env.version !== TRANSFORMERS_VERSION) {
      return { reason: `missing (found ${mod.env.version})`, hint: INSTALL_HINT };
    }
    return { module: mod };
  } catch (err) {
    return { reason: `missing (${err instanceof Error ? err.message : err})`, hint: INSTALL_HINT };
  }
}

export class EmbeddingGemmaProvider implements EmbeddingProvider {
  readonly name = "embeddinggemma";
  readonly dimensions = 768;

  private model: any = null;
  private processor: any = null;
  private initPromise: Promise<void> | null = null;

  private async init(): Promise<void> {
    if (this.model) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    const result = await loadTransformers();
    if (!("module" in result)) {
      const hint = result.hint ? `. ${result.hint}` : "";
      throw new Error(`EMBEDDING_MODEL=embeddinggemma-2 needs @huggingface/transformers ${TRANSFORMERS_VERSION} (${result.reason})${hint}`);
    }
    console.error("[agent-fs] Resolving local embedding model...");
    const { AutoConfig, AutoProcessor, AutoModel } = result.module;
    const cache_dir = join(getHome(), "models");
    // A load by model id asks huggingface.co about the tokenizer every time,
    // even when every file is cached (transformers 4.3.1 drops cache_dir for
    // that check), so it fails offline. A load from the cache directory path
    // stays offline. Only a cache with files missing loads by id and downloads.
    const cached = join(cache_dir, MODEL);
    const source = TEXT_MODEL_FILES.every((file) => existsSync(join(cached, file))) ? cached : MODEL;
    const config: any = await AutoConfig.from_pretrained(source, { cache_dir });
    // Without these configs the model creates no vision or audio session.
    config.vision_config = null;
    config.audio_config = null;
    this.processor = await AutoProcessor.from_pretrained(source, { cache_dir });
    this.model = await AutoModel.from_pretrained(source, { config, dtype: "q8", device: "cpu", cache_dir });
    console.error("[agent-fs] Model ready: embeddinggemma-2");
  }

  private async embedText(text: string): Promise<number[]> {
    await this.init();
    const inputs = await this.processor([text], null, null, null, { truncation: false });
    const tokens = inputs.input_ids.dims[1];
    if (tokens > MAX_TOKENS) {
      throw new EmbeddingProviderError(`EmbeddingGemma 2 input exceeds ${MAX_TOKENS} tokens (${tokens} tokens).`);
    }
    const { sentence_embedding } = await this.model(inputs);
    return Array.from(sentence_embedding.data as Float32Array);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.embedText(`task: search result | query: ${text}`);
  }

  async embedDocuments(texts: string[], { title }: { title: string }): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) results.push(await this.embedText(`title: ${title} | text: ${text}`));
    return results;
  }

  async dispose(): Promise<void> {
    await this.initPromise?.catch(() => {});
    try {
      if (this.model) await this.model.dispose();
    } finally {
      this.model = null;
      this.processor = null;
      this.initPromise = null;
    }
  }
}
