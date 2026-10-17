import { describe, expect, mock, test } from "bun:test";
import { EmbeddingGemmaProvider, linuxRuntimeConflict } from "../embeddings/embeddinggemma.js";
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
