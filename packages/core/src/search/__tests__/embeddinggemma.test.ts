import { describe, expect, mock, spyOn, test } from "bun:test";
import { TRANSFORMERS_VERSION, INSTALL_HINT } from "../embeddings/embeddinggemma.js";
import { EmbeddingGemmaRuntime, startWorker, type RuntimeOptions, type WorkerScope, embeddingGemmaSource } from "../embeddings/embeddinggemma-runtime.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAIEmbeddingProvider } from "../embeddings/openai.js";
import { GeminiEmbeddingProvider } from "../embeddings/gemini.js";
import { LocalEmbeddingProvider } from "../embeddings/local.js";

const options: RuntimeOptions = { paths: {}, cacheDir: join(tmpdir(), "agent-fs-eg2-missing"), version: TRANSFORMERS_VERSION, hint: INSTALL_HINT };

function fakeProvider(tokens = 10) {
  const provider = new EmbeddingGemmaRuntime(options);
  const processor = mock(async (..._args: any[]) => ({ input_ids: { dims: [1, tokens] } }));
  const model = Object.assign(mock(async (_inputs: unknown) => ({
    sentence_embedding: { data: new Float32Array(768).fill(0.5) },
  })), { dispose: mock(async () => {}) });
  Object.assign(provider, { processor, model });
  return { provider, processor, model };
}

describe("EmbeddingGemmaRuntime", () => {
  test("retries failed probes and shares the successful import with text and vision", async () => {
    const from_pretrained = mock(async () => ({}));
    const load = mock(async () => ({ env: { version: "4.3.1" }, AutoConfig: { from_pretrained } }));
    load.mockRejectedValueOnce(new Error("missing"));
    const provider = new EmbeddingGemmaRuntime({ ...options, paths: { transformers: "fake" } }, load);
    expect(await (provider as any).probe()).toMatchObject({ reason: "missing (@huggingface/transformers: missing)" });
    expect(await (provider as any).probe()).toEqual({ module: true });
    expect(await (provider as any).probe()).toEqual({ module: true });
    const text = await (provider as any).loader(false);
    const vision = await (provider as any).loader(true);
    expect(text.config.audio_config).toBeNull();
    expect(vision.config.audio_config).toBeNull();
    expect(from_pretrained).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("guards unresolved package paths before import", async () => {
    const load = mock(async () => ({}));
    const runtime = new EmbeddingGemmaRuntime(options, load);
    expect(await runtime.probe()).toMatchObject({ reason: expect.stringContaining("@huggingface/transformers") });
    await expect(runtime.loadCanvas()).rejects.toMatchObject({ name: "CanvasImportError", message: expect.stringContaining("@napi-rs/canvas") });
    await expect(runtime.renderPdfPages(new Uint8Array(), 1)).rejects.toThrow("unpdf");
    expect(load).not.toHaveBeenCalled();
  });

  test("keeps the version and install hint in initialization errors", async () => {
    const provider = new EmbeddingGemmaRuntime({ ...options, paths: { transformers: "fake" } }, async () => ({ env: { version: "3.8.1" } }));
    await expect(provider.embedQuery("a")).rejects.toThrow("embeddinggemma-2 needs @huggingface/transformers 4.3.1 (missing (found 3.8.1)). Run: bun add -g @huggingface/transformers@4.3.1");
  });

  test("adds task prefixes and embeds one document per forward pass", async () => {
    const { provider, processor, model } = fakeProvider();
    expect(await provider.embedQuery("cats")).toHaveLength(768);
    expect(await provider.embedDocuments(["cats purr", "cars drive"], { title: "notes.md" })).toHaveLength(2);
    expect(processor.mock.calls).toEqual([
      [["task: search result | query: cats"], null, null, null, { truncation: false }],
      [["title: notes.md | text: cats purr"], null, null, null, { truncation: false }],
      [["title: notes.md | text: cars drive"], null, null, null, { truncation: false }],
    ]);
    expect(model).toHaveBeenCalledTimes(3);
    await provider.dispose();
    expect(model.dispose).toHaveBeenCalledTimes(1);
    expect(provider).toMatchObject({ model: null, processor: null, initPromise: null });
  });

  test("rejects more than 8192 tokens before inference", async () => {
    const { provider, model } = fakeProvider(8193);
    await expect(provider.embedQuery("too long")).rejects.toMatchObject({ name: "EmbeddingProviderError" });
    expect(model).not.toHaveBeenCalled();
    expect(await fakeProvider(8192).provider.embedQuery("fits")).toHaveLength(768);
  });

  test.each([EmbeddingGemmaRuntime, LocalEmbeddingProvider])("%p retries a failed single-flight initialization", async (Provider) => {
    const provider = Provider === EmbeddingGemmaRuntime ? new EmbeddingGemmaRuntime(options) : new LocalEmbeddingProvider();
    let attempts = 0;
    Object.assign(provider, {
      _doInit: mock(async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary failure");
        Object.assign(provider, {
          model: async () => ({ sentence_embedding: { data: new Float32Array(768) } }),
          processor: async () => ({ input_ids: { dims: [1, 10] } }),
          embeddingContext: { getEmbeddingFor: async () => ({ vector: new Float32Array(768) }) },
        });
      }),
    });
    const first = provider.embedQuery("a");
    const concurrent = provider.embedQuery("b");
    const results = await Promise.allSettled([first, concurrent]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe("temporary failure");
    }
    expect(attempts).toBe(1);
    expect(await provider.embedQuery("retry")).toHaveLength(768);
    expect(attempts).toBe(2);
  });
});

function fakeVision() {
  const { provider, model: textModel } = fakeProvider();
  const models: any[] = [];
  const processor = mock(async (..._args: any[]) => ({ pixel_values: true }));
  const fromBlob = mock(async (_blob: Blob) => ({ image: true }));
  const init = mock(async () => {
    const model = Object.assign(mock(async (_inputs: unknown) => ({
      sentence_embedding: { data: new Float32Array(768).fill(0.5) },
    })), { dispose: mock(async () => {}) });
    models.push(model);
    Object.assign(provider, { visionModel: model, visionProcessor: processor, rawImage: { fromBlob } });
  });
  Object.assign(provider, { _doInitVision: init });
  return { provider, textModel, models, init, processor, fromBlob };
}

const part = { mime: "image/png", data: new Uint8Array([1, 2, 3]) };

describe("EmbeddingGemmaRuntime images", () => {
  test("selects a local path only when every required file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fs-eg2-source-"));
    const id = "onnx-community/embeddinggemma-2-ONNX";
    const cached = join(dir, id);
    const files = [
      "config.json", "preprocessor_config.json", "processor_config.json", "tokenizer_config.json",
      "tokenizer.json", "chat_template.jinja", "onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data",
      "onnx/vision_encoder_quantized.onnx", "onnx/vision_encoder_quantized.onnx_data",
    ];
    mkdirSync(join(cached, "onnx"), { recursive: true });
    try {
      expect(embeddingGemmaSource(dir, true)).toBe(id);
      for (const file of files) writeFileSync(join(cached, file), "cached");
      expect(embeddingGemmaSource(dir, true)).toBe(cached);
      for (const file of files) {
        unlinkSync(join(cached, file));
        expect(embeddingGemmaSource(dir, true)).toBe(id);
        if (file.includes("vision_encoder")) expect(embeddingGemmaSource(dir, false)).toBe(cached);
        else expect(embeddingGemmaSource(dir, false)).toBe(id);
        writeFileSync(join(cached, file), "cached");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("text providers omit image methods", () => {
    for (const provider of [new LocalEmbeddingProvider(), new OpenAIEmbeddingProvider("test"), new GeminiEmbeddingProvider("test")]) {
      expect("supportsMime" in provider).toBe(false);
      expect("embedParts" in provider).toBe(false);
    }
  });

  test("decodes bytes and embeds one image per call without a prefix", async () => {
    const { provider, processor, fromBlob, init, models, textModel } = fakeVision();
    try {
      expect(await provider.embedParts([part, part])).toHaveLength(2);
      expect(init).toHaveBeenCalledTimes(1);
      expect(fromBlob).toHaveBeenCalledTimes(2);
      expect(await fromBlob.mock.calls[0][0].arrayBuffer()).toEqual(part.data.buffer);
      expect(processor.mock.calls).toEqual([[null, { image: true }], [null, { image: true }]]);
      expect(models[0]).toHaveBeenCalledTimes(2);
      expect(textModel).not.toHaveBeenCalled();
    } finally {
      await provider.dispose();
    }
    expect(models[0].dispose).toHaveBeenCalledTimes(1);
    expect(textModel.dispose).toHaveBeenCalledTimes(1);
  });

  test("serializes concurrent calls and waits for inference before disposal", async () => {
    const { provider, init, models } = fakeVision();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { started = resolve; });
    await init();
    models[0].mockImplementationOnce(async () => {
      started();
      await gate;
      return { sentence_embedding: { data: new Float32Array(768) } };
    });
    const scope: WorkerScope = { onmessage: null, postMessage() {} };
    startWorker(scope, provider);
    const replies: unknown[] = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    scope.postMessage = (reply) => { replies.push(reply); if (replies.length === 3) finish(); };
    scope.onmessage!({ data: { id: 1, type: "image", part } });
    await running;
    scope.onmessage!({ data: { id: 2, type: "image", part } });
    scope.onmessage!({ data: { id: 3, type: "dispose" } });
    expect(models[0]).toHaveBeenCalledTimes(1);
    expect(models[0].dispose).not.toHaveBeenCalled();
    release();
    await done;
    expect(models[0]).toHaveBeenCalledTimes(2);
    expect(models[0].dispose).toHaveBeenCalledTimes(1);
    expect((provider as any).visionIdleTimer).toBeNull();
  });

  test("clears both models when vision disposal fails", async () => {
    const { provider, models, textModel } = fakeVision();
    await provider.embedParts([part]);
    models[0].dispose.mockRejectedValueOnce(new Error("disposal failed"));
    await expect(provider.dispose()).rejects.toThrow("disposal failed");
    expect(textModel.dispose).toHaveBeenCalledTimes(1);
    expect(provider).toMatchObject({
      model: null, processor: null, initPromise: null,
      visionModel: null, visionProcessor: null, rawImage: null, visionIdleTimer: null,
    });
  });

  test("recycles after 50 images and creates another model for image 51", async () => {
    const { provider, models, init } = fakeVision();
    try {
      expect(await provider.embedParts(Array.from({ length: 51 }, () => part))).toHaveLength(51);
      expect(init).toHaveBeenCalledTimes(2);
      expect(models[0]).toHaveBeenCalledTimes(50);
      expect(models[0].dispose).toHaveBeenCalledTimes(1);
      expect(models[1]).toHaveBeenCalledTimes(1);
      expect(models[1].dispose).not.toHaveBeenCalled();
    } finally {
      await provider.dispose();
    }
  });

  test("disposes after 60 idle seconds and recreates on the next call", async () => {
    const { provider, init, models, textModel } = fakeVision();
    let expire!: () => void;
    const unref = mock(() => {});
    const scope: WorkerScope = { onmessage: null, postMessage() {} };
    startWorker(scope, provider);
    const setTimer = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      if (ms !== 60_000) return setTimer(callback, ms);
      expire = callback;
      return { unref };
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      await provider.embedParts([part]);
      expect(unref).toHaveBeenCalledTimes(1);
      expire();
      // This document completes after idle cleanup in the worker queue.
      await new Promise<void>((resolve) => {
        scope.postMessage = () => resolve();
        scope.onmessage!({ data: { id: 1, type: "document", text: "barrier", title: "idle" } });
      });
      expect(models[0].dispose).toHaveBeenCalledTimes(1);
      expect(textModel.dispose).not.toHaveBeenCalled();
      await provider.embedParts([part]);
      expect(init).toHaveBeenCalledTimes(2);
    } finally {
      await provider.dispose();
      timer.mockRestore();
      clear.mockRestore();
    }
  });

  test("a stale idle callback cannot dispose the current vision model", async () => {
    const { provider, models } = fakeVision();
    const callbacks: Array<() => void> = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callbacks.push(callback);
      return { unref() {} };
    }) as any);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      await provider.embedParts([part]);
      await provider.embedParts([part]);
      await callbacks[0]();
      expect(models[0].dispose).not.toHaveBeenCalled();
      await callbacks[1]();
      expect(models[0].dispose).toHaveBeenCalledTimes(1);
    } finally {
      await provider.dispose();
      timer.mockRestore();
      clear.mockRestore();
    }
  });

  test("classifies initialization errors and retries the next call", async () => {
    const { provider, init } = fakeVision();
    init.mockImplementationOnce(async () => { throw new Error("download failed"); });
    await expect(provider.embedParts([part])).rejects.toMatchObject({ name: "EmbeddingInitializationError" });
    try {
      expect(await provider.embedParts([part])).toHaveLength(1);
      expect(init).toHaveBeenCalledTimes(2);
    } finally {
      await provider.dispose();
    }
  });

  test("keeps decode errors separate from initialization errors", async () => {
    const { provider, fromBlob } = fakeVision();
    const failure = new Error("invalid image bytes");
    fromBlob.mockRejectedValueOnce(failure);
    try {
      await expect(provider.embedParts([part])).rejects.toBe(failure);
      expect(await provider.embedParts([part])).toHaveLength(1);
    } finally {
      await provider.dispose();
    }
  });
});
