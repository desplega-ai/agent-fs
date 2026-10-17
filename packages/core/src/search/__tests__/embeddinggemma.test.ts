import { describe, expect, mock, spyOn, test } from "bun:test";
import { EmbeddingGemmaProvider, embeddingGemmaSource, linuxRuntimeConflict, type TransformersResult } from "../embeddings/embeddinggemma.js";
import * as embeddinggemma from "../embeddings/embeddinggemma.js";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddingInitializationError } from "../embeddings/provider.js";
import { OpenAIEmbeddingProvider } from "../embeddings/openai.js";
import { GeminiEmbeddingProvider } from "../embeddings/gemini.js";
import { LocalEmbeddingProvider } from "../embeddings/local.js";
import { EmbeddingProviderError } from "../../errors.js";

function fakeProvider(tokens = 10) {
  const provider = new EmbeddingGemmaProvider();
  const processor = mock(async (..._args: any[]) => ({ input_ids: { dims: [1, tokens] } }));
  const model = Object.assign(mock(async (_inputs: unknown) => ({
    sentence_embedding: { data: new Float32Array(768).fill(0.5) },
  })), { dispose: mock(async () => {}) });
  Object.assign(provider, { processor, model });
  return { provider, processor, model };
}

describe("EmbeddingGemma 2", () => {
  test("retries failed probes and caches only a successful result", async () => {
    const unavailable = { reason: "missing (test)", hint: "Install transformers" };
    const from_pretrained = mock(async () => ({}));
    const available = { module: { AutoConfig: { from_pretrained } } } as unknown as TransformersResult;
    const load = spyOn(embeddinggemma, "loadTransformers")
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValue(available);
    try {
      const provider = new EmbeddingGemmaProvider(unavailable);
      const loader = (provider as any).loader.bind(provider);
      await expect(loader(false)).rejects.toThrow("embeddinggemma-2 needs @huggingface/transformers 4.3.1 (missing (test)). Install transformers");
      expect(load).toHaveBeenCalledTimes(1);
      await loader(false);
      await loader(true);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      load.mockRestore();
    }
  });

  test("reuses the boot transformers result for text and vision", async () => {
    const from_pretrained = mock(async () => ({}));
    const module = { AutoConfig: { from_pretrained } };
    const provider = new EmbeddingGemmaProvider({ module } as unknown as TransformersResult);
    const text = await (provider as any).loader(false);
    const vision = await (provider as any).loader(true);
    expect(text.AutoConfig).toBe(module.AutoConfig);
    expect(vision.AutoConfig).toBe(module.AutoConfig);
    expect(from_pretrained).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["linux", "3.8.1", true],
    ["linux", "4.3.1", false],
    ["linux", undefined, false],
    ["darwin", "3.8.1", false],
    ["win32", "3.8.1", false],
  ] as const)("checks the ONNX runtime conflict on %s with %s", (platform, version, blocked) => {
    const reason = linuxRuntimeConflict(platform, version);
    expect(!!reason).toBe(blocked);
    if (blocked) {
      expect(reason).toContain("chonkie loads @huggingface/transformers 3.8.1");
      expect(reason).toContain("Use the Docker image");
      expect(reason).not.toContain("bun add");
    }
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
    await expect(provider.embedQuery("too long")).rejects.toBeInstanceOf(EmbeddingProviderError);
    expect(model).not.toHaveBeenCalled();
    expect(await fakeProvider(8192).provider.embedQuery("fits")).toHaveLength(768);
  });

  test.each([EmbeddingGemmaProvider, LocalEmbeddingProvider])("%p retries a failed single-flight initialization", async (Provider) => {
    const provider = new Provider();
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

describe("EmbeddingGemma 2 images", () => {
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

  test("supports four image types and rejects unsupported parts before initialization", async () => {
    const { provider, init } = fakeVision();
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) expect(provider.supportsMime(mime)).toBe(true);
    for (const mime of ["image/svg+xml", "application/pdf", "text/plain"]) expect(provider.supportsMime(mime)).toBe(false);
    await expect(provider.embedParts([{ ...part, mime: "image/svg+xml" }])).rejects.toThrow("Unsupported embedding MIME type");
    expect(await provider.embedParts([])).toEqual([]);
    expect(init).not.toHaveBeenCalled();
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
    const first = provider.embedParts([part]);
    await running;
    const second = provider.embedParts([part]);
    const disposed = provider.dispose();
    expect(models[0]).toHaveBeenCalledTimes(1);
    expect(models[0].dispose).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second, disposed]);
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
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      expect(ms).toBe(60_000);
      expire = callback;
      return { unref };
    }) as any);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      await provider.embedParts([part]);
      expect(unref).toHaveBeenCalledTimes(1);
      expire();
      await (provider as any).visionQueue;
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
      callbacks[0]();
      await (provider as any).visionQueue;
      expect(models[0].dispose).not.toHaveBeenCalled();
      callbacks[1]();
      await (provider as any).visionQueue;
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
    const first = provider.embedParts([part]);
    const concurrent = provider.embedParts([part]);
    await expect(first).rejects.toBeInstanceOf(EmbeddingInitializationError);
    try {
      expect(await concurrent).toHaveLength(1);
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
