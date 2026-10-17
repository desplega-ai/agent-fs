// This JavaScript source runs as text in a blob worker without compilation.
// Keep it self-contained. Do not add relative imports.
// Import packages only through the absolute paths in the runtime options.
import { existsSync } from "node:fs";
import { join } from "node:path";

class EmbeddingProviderError extends Error {
  name = "EmbeddingProviderError";
}

class EmbeddingInitializationError extends Error {
  name = "EmbeddingInitializationError";
  constructor(cause) {
    super(`Embedding model initialization failed: ${cause instanceof Error ? cause.message : cause}`, { cause });
  }
}

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
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

export function embeddingGemmaSource(cacheDir, vision) {
  const cached = join(cacheDir, MODEL);
  const files = vision ? VISION_MODEL_FILES : TEXT_MODEL_FILES;
  return files.every((file) => existsSync(join(cached, file))) ? cached : MODEL;
}

export class EmbeddingGemmaRuntime {
  name = "embeddinggemma";
  dimensions = 768;
  model = null;
  processor = null;
  initPromise = null;
  visionModel = null;
  visionProcessor = null;
  rawImage = null;
  visionImages = 0;
  visionIdleTimer = null;
  transformers;
  constructor(options, loadModule = (path) => import(path)) {
    this.options = options;
    this.loadModule = loadModule;
    this.transformers = null;
    this.scheduleIdle = (run) => run();
  }

  async loadTransformers() {
    try {
      if (!this.options.paths.transformers) throw new Error("Cannot resolve @huggingface/transformers");
      const mod = await this.loadModule(this.options.paths.transformers);
      if (mod.env.version !== this.options.version) {
        return { reason: `missing (found ${mod.env.version})`, hint: this.options.hint };
      }

      return { module: mod };
    } catch (err) {
      return { reason: `missing (@huggingface/transformers: ${err instanceof Error ? err.message : err})`, hint: this.options.hint };
    }
  }

  async probe() {
    const result = await (this.transformers ??= this.loadTransformers());
    if (!("module" in result)) this.transformers = null;
    return "module" in result ? { module: true } : result;
  }

  async init() {
    if (this.model) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  async loader(vision) {
    const result = await (this.transformers ??= this.loadTransformers());
    if (!("module" in result)) {
      this.transformers = null;
      const hint = result.hint ? `. ${result.hint}` : "";
      throw new Error(`embeddinggemma-2 needs @huggingface/transformers ${this.options.version} (${result.reason})${hint}`);
    }

    const cache_dir = this.options.cacheDir;
    // Transformers 4.3.1 checks complete caches by path without a network request.
    const source = embeddingGemmaSource(cache_dir, vision);
    const config = await result.module.AutoConfig.from_pretrained(source, { cache_dir });
    config.audio_config = null;
    return { ...result.module, source, cache_dir, config };
  }

  async _doInit() {
    console.error("[agent-fs] Resolving local embedding model...");
    const { AutoProcessor, AutoModel, source, cache_dir, config } = await this.loader(false);
    // Disable the vision session for text embeddings.
    config.vision_config = null;
    this.processor = await AutoProcessor.from_pretrained(source, { cache_dir });
    this.model = await AutoModel.from_pretrained(source, { config, dtype: "q8", device: "cpu", cache_dir });
    console.error("[agent-fs] Model ready: embeddinggemma-2");
  }

  async embedText(text) {
    await this.init();
    const inputs = await this.processor([text], null, null, null, { truncation: false });
    const tokens = inputs.input_ids.dims[1];
    if (tokens > MAX_TOKENS) {
      throw new EmbeddingProviderError(`EmbeddingGemma 2 input exceeds ${MAX_TOKENS} tokens (${tokens} tokens).`);
    }

    const { sentence_embedding } = await this.model(inputs);
    return Array.from(sentence_embedding.data);
  }

  embedQuery(text) {
    return this.embedText(`task: search result | query: ${text}`);
  }

  async embedDocuments(texts, { title }) {
    const results = [];
    for (const text of texts) results.push(await this.embedText(`title: ${title} | text: ${text}`));
    return results;
  }

  async initVision() {
    if (this.visionModel) return;
    try {
      await this._doInitVision();
    } catch (err) {
      throw new EmbeddingInitializationError(err);
    }
  }

  async _doInitVision() {
    const { AutoProcessor, AutoModel, RawImage, source, cache_dir, config } = await this.loader(true);
    const processor = await AutoProcessor.from_pretrained(source, { cache_dir });
    processor.image_processor.max_soft_tokens = IMAGE_TOKEN_BUDGET;
    const model = await AutoModel.from_pretrained(source, {
      config,
      dtype: { model: "q8", vision_encoder: "q8" },
      device: "cpu",
      cache_dir,
    });
    this.visionProcessor = processor;
    this.visionModel = model;
    this.rawImage = RawImage;
  }

  clearVisionTimer() {
    if (this.visionIdleTimer) clearTimeout(this.visionIdleTimer);
    this.visionIdleTimer = null;
  }

  async disposeVision() {
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

  async embedParts(parts) {
    this.clearVisionTimer();
    try {
      const vectors = [];
      for (const { data } of parts) {
        await this.initVision();
        const image = await this.rawImage.fromBlob(new Blob([data.slice()]));
        const inputs = await this.visionProcessor(null, image);
        const { sentence_embedding } = await this.visionModel(inputs);
        vectors.push(Array.from(sentence_embedding.data));
        this.visionImages++;
        if (this.visionImages >= VISION_IMAGE_LIMIT) await this.disposeVision();
      }

      return vectors;
    } finally {
      if (this.visionModel) {
        const timer = setTimeout(() => {
          return this.scheduleIdle(async () => {
            if (this.visionIdleTimer === timer) await this.disposeVision();
          }).catch((err) => {
            console.error("[agent-fs] Vision model cleanup failed:", err);
          });
        }, VISION_IDLE_MS);
        this.visionIdleTimer = timer;
        timer.unref();
      }
    }
  }

  async loadCanvas() {
    try {
      if (!this.options.paths.canvas) throw new Error("Cannot resolve @napi-rs/canvas");
      return await this.loadModule(this.options.paths.canvas);
    } catch (err) {
      const error = new Error(`@napi-rs/canvas import failed: ${err instanceof Error ? err.message : err}`);
      error.name = "CanvasImportError";
      throw error;
    }
  }

  async renderPdfPages(bytes, n) {
    if (!this.options.paths.unpdf) throw new Error("Cannot resolve unpdf");
    const { getDocumentProxy, renderPageAsImage } = await this.loadModule(this.options.paths.unpdf).catch((err) => {
      throw new Error(`unpdf import failed: ${err instanceof Error ? err.message : err}`);
    });
    const options = { isEvalSupported: false, verbosity: 0 };
    const pdf = await getDocumentProxy(bytes.slice(), options);
    try {
      const pages = [];
      for (let page = 1; page <= Math.min(n, pdf.numPages); page++) {
        try {
          const buffer = await renderPageAsImage(pdf, page, {
            canvasImport: () => this.loadCanvas(),
            width: 1024,
          });
          pages.push({ page, data: new Uint8Array(buffer) });
        } catch (err) {
          const message = String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, " ");
          console.error(`[agent-fs] PDF page ${page} rendering failed: ${message}`);
        }
      }

      return pages;
    } finally {
      await pdf.loadingTask.destroy();
    }
  }

  async dispose() {
    try {
      await this.disposeVision();
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

export function startWorker(scope, runtime) {
  const queue = [];
  let running = false;
  let scheduled = false;
  const schedule = () => {
    if (running || scheduled) return;
    scheduled = true;
    setTimeout(pump, 0);
  };
  const enqueue = (job) => {
    if (job.type === "query") {
      const index = queue.findIndex((item) => item.type !== "query");
      queue.splice(index < 0 ? queue.length : index, 0, job);
    } else {
      queue.push(job);
    }

    schedule();
  };
  async function pump() {
    scheduled = false;
    if (running || !queue.length) return;
    running = true;
    const job = queue.shift();
    try {
      let result;
      switch (job.type) {
        case "probe": result = await runtime.probe(); break;
        case "query": result = await runtime.embedQuery(job.text); break;
        case "document": result = (await runtime.embedDocuments([job.text], { title: job.title }))[0]; break;
        case "image": result = (await runtime.embedParts([job.part]))[0]; break;
        case "pdf": result = await runtime.renderPdfPages(job.bytes, job.n); break;
        case "canvas": await runtime.loadCanvas(); result = true; break;
        case "idle": await job.run(); break;
        case "dispose": await runtime.dispose(); break;
        default: throw new Error(`Unknown embedding worker job: ${job.type}`);
      }

      if (job.id != null) scope.postMessage({ id: job.id, result });
      job.resolve?.();
    } catch (err) {
      if (job.id != null) {
        scope.postMessage({ id: job.id, error: {
          name: err.name, message: err.message || String(err),
          cause: err.cause instanceof Error ? err.cause.message : String(err.cause),
        } });
      }

      job.reject?.(err);
    } finally {
      running = false;
      // Give incoming queries a turn before the next indexing job.
      schedule();
    }
  }
  const scheduleIdle = (run) => new Promise((resolve, reject) => enqueue({ type: "idle", run, resolve, reject }));
  if (runtime) runtime.scheduleIdle = scheduleIdle;
  scope.onmessage = ({ data }) => {
    if (data.type === "open") {
      runtime = new EmbeddingGemmaRuntime(data.options);
      runtime.scheduleIdle = scheduleIdle;
    } else {
      enqueue(data);
    }
  };
}
