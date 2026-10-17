import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHome } from "../../config.js";
import { EmbeddingProviderError } from "../../errors.js";
import { EmbeddingInitializationError, type EmbeddingPart, type EmbeddingProvider } from "./provider.js";

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
const TRANSFORMERS_VERSION = "4.3.1";
const INSTALL_HINT = `Run: bun add -g @huggingface/transformers@${TRANSFORMERS_VERSION}`;
const MAX_TOKENS = 8192;
const IMAGE_TOKEN_BUDGET = 140;
const VISION_IDLE_MS = 60_000;
const VISION_IMAGE_LIMIT = 50;

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

const VISION_MODEL_FILES = [
  ...TEXT_MODEL_FILES,
  "onnx/vision_encoder_quantized.onnx",
  "onnx/vision_encoder_quantized.onnx_data",
];

export function embeddingGemmaSource(cacheDir: string, vision: boolean): string {
  const cached = join(cacheDir, MODEL);
  const files = vision ? VISION_MODEL_FILES : TEXT_MODEL_FILES;
  return files.every((file) => existsSync(join(cached, file))) ? cached : MODEL;
}

export type TransformersResult =
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
  private visionModel: any = null;
  private visionProcessor: any = null;
  private rawImage: typeof import("@huggingface/transformers").RawImage | null = null;
  private visionImages = 0;
  private visionQueue: Promise<void> = Promise.resolve();
  private visionIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private transformers: Promise<TransformersResult> | null;

  constructor(transformers?: TransformersResult) {
    this.transformers = transformers && "module" in transformers ? Promise.resolve(transformers) : null;
  }

  private async init(): Promise<void> {
    if (this.model) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async loader(vision: boolean) {
    const result = await (this.transformers ??= loadTransformers());
    if (!("module" in result)) {
      this.transformers = null;
      const hint = result.hint ? `. ${result.hint}` : "";
      throw new Error(`embeddinggemma-2 needs @huggingface/transformers ${TRANSFORMERS_VERSION} (${result.reason})${hint}`);
    }
    const cache_dir = join(getHome(), "models");
    // Transformers 4.3.1 drops cache_dir in its tokenizer file check.
    // Load complete caches by path because loading by ID makes a network request.
    const source = embeddingGemmaSource(cache_dir, vision);
    const config: any = await result.module.AutoConfig.from_pretrained(source, { cache_dir });
    config.audio_config = null;
    return { ...result.module, source, cache_dir, config };
  }

  private async _doInit(): Promise<void> {
    console.error("[agent-fs] Resolving local embedding model...");
    const { AutoProcessor, AutoModel, source, cache_dir, config } = await this.loader(false);
    // Disable the vision session for text embeddings.
    config.vision_config = null;
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

  supportsMime(mime: string): boolean {
    return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
  }

  private async initVision(): Promise<void> {
    if (this.visionModel) return;
    try {
      await this._doInitVision();
    } catch (err) {
      throw new EmbeddingInitializationError(err);
    }
  }

  private async _doInitVision(): Promise<void> {
    const { AutoProcessor, AutoModel, RawImage, source, cache_dir, config } = await this.loader(true);
    const processor: any = await AutoProcessor.from_pretrained(source, { cache_dir });
    processor.image_processor.max_soft_tokens = IMAGE_TOKEN_BUDGET;
    const model = await AutoModel.from_pretrained(source, {
      config, dtype: { model: "q8", vision_encoder: "q8" }, device: "cpu", cache_dir,
    });
    this.visionProcessor = processor;
    this.visionModel = model;
    this.rawImage = RawImage;
  }

  private serializeVision<T>(run: () => Promise<T>): Promise<T> {
    const result = this.visionQueue.then(run);
    this.visionQueue = result.then(() => {}, () => {});
    return result;
  }

  private clearVisionTimer(): void {
    if (this.visionIdleTimer) clearTimeout(this.visionIdleTimer);
    this.visionIdleTimer = null;
  }

  private async disposeVision(): Promise<void> {
    this.clearVisionTimer();
    try {
      if (this.visionModel) await this.visionModel.dispose();
    } finally {
      this.visionModel = null;
      this.visionProcessor = null;
      this.rawImage = null;
      this.visionImages = 0;
    }
  }

  async embedParts(parts: EmbeddingPart[]): Promise<number[][]> {
    for (const part of parts) {
      if (!this.supportsMime(part.mime)) throw new Error(`Unsupported embedding MIME type: ${part.mime}`);
    }
    return this.serializeVision(async () => {
      this.clearVisionTimer();
      try {
        const vectors: number[][] = [];
        for (const { data } of parts) {
          await this.initVision();
          const image = await this.rawImage!.fromBlob(new Blob([data.slice()]));
          const inputs = await this.visionProcessor(null, image);
          const { sentence_embedding } = await this.visionModel(inputs);
          vectors.push(Array.from(sentence_embedding.data as Float32Array));
          this.visionImages++;
          if (this.visionImages >= VISION_IMAGE_LIMIT) await this.disposeVision();
        }
        return vectors;
      } finally {
        if (this.visionModel) {
          const timer = setTimeout(() => {
            void this.serializeVision(async () => {
              if (this.visionIdleTimer === timer) await this.disposeVision();
            }).catch((err) => {
              console.error("[agent-fs] Vision model cleanup failed:", err);
            });
          }, VISION_IDLE_MS);
          this.visionIdleTimer = timer;
          timer.unref();
        }
      }
    });
  }

  async dispose(): Promise<void> {
    try {
      await this.serializeVision(() => this.disposeVision());
    } finally {
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
}
