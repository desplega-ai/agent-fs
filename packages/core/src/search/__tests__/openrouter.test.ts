import { expect, test, spyOn } from "bun:test";
import type OpenAI from "openai";
import type { Database } from "bun:sqlite";
import { OpenRouterEmbeddingProvider } from "../embeddings/openrouter.js";
import { EmbeddingProviderError } from "../../errors.js";
import { createTestContext } from "../../test-utils.js";
import { write } from "../../ops/write.js";
import { vecSearch } from "../../ops/vec-search.js";
import { embeddingFormat, prepareEmbeddingMigrationWithWarmup, runPendingEmbeddings } from "../embedding-migration.js";

function vector(axis = 0): number[] {
  return Array.from({ length: 768 }, (_, i) => i === axis ? 1 : 0);
}

function mockTransport(provider: OpenRouterEmbeddingProvider, handler: (request: Request) => Response | Promise<Response>) {
  const { client } = provider as unknown as { client: OpenAI };
  Object.assign(provider, {
    client: client.withOptions({
      maxRetries: 0,
      fetch: async (url, init) => handler(new Request(url, init)),
    }),
  });
}

test("OpenRouter sends float embeddings to its endpoint and preserves document order", async () => {
  const provider = new OpenRouterEmbeddingProvider("router-test-key");
  const inputs: unknown[] = [];
  mockTransport(provider, async (request) => {
    expect(request.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(request.headers.get("authorization")).toBe("Bearer router-test-key");
    const body = await request.json();
    expect(body.model).toBe("openai/text-embedding-3-small");
    expect(body.dimensions).toBe(768);
    expect(body.encoding_format).toBe("float");
    inputs.push(body.input);
    const texts = typeof body.input === "string" ? [body.input] : body.input;
    return Response.json({ data: texts.map((_: string, index: number) => ({ index, embedding: vector(index) })).reverse() });
  });
  expect(await provider.embedQuery("  café\nquery  ")).toEqual(vector());
  expect(await provider.embedDocuments(["first", "second"], { title: "notes.md" })).toEqual([vector(), vector(1)]);
  expect(await provider.embedDocuments([], { title: "empty.md" })).toEqual([]);
  expect(inputs).toEqual(["  café\nquery  ", ["first", "second"]]);
});

test("OpenRouter splits document batches and honors the configured model", async () => {
  const provider = new OpenRouterEmbeddingProvider("router-test-key", "openai/text-embedding-3-large");
  const inputs: string[][] = [];
  mockTransport(provider, async (request) => {
    const body = await request.json();
    expect(body.model).toBe("openai/text-embedding-3-large");
    inputs.push(body.input);
    return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: vector() })) });
  });
  const texts = ["a".repeat(130_000), "b".repeat(130_000), "c"];
  expect(await provider.embedDocuments(texts, { title: "large.txt" })).toHaveLength(3);
  expect(inputs).toEqual([[texts[0]], [texts[1], texts[2]]]);
});

test.each([401, 402, 429, 503])("OpenRouter reports HTTP %s without exposing response bodies", async (status) => {
  const provider = new OpenRouterEmbeddingProvider("router-test-key");
  mockTransport(provider, () => Response.json({ error: { message: "secret-key-and-private-document" } }, { status }));
  try {
    await provider.embedQuery("private document");
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).not.toContain("secret-key-and-private-document");
  }
});

test.each([
  ["missing vectors", []],
  ["wrong dimensions", [{ index: 0, embedding: [1, 2] }]],
  ["zero vector", [{ index: 0, embedding: vector(-1) }]],
  ["overflow", [{ index: 0, embedding: vector().map(x => x * 1e39) }]],
  ["wrong index", [{ index: 1, embedding: vector() }]],
  ["base64", [{ index: 0, embedding: "AAAA" }]],
] as const)("OpenRouter rejects %s", async (_, data) => {
  const provider = new OpenRouterEmbeddingProvider("router-test-key");
  mockTransport(provider, () => Response.json({ data }));
  await expect(provider.embedQuery("query")).rejects.toBeInstanceOf(EmbeddingProviderError);
});

test("OpenRouter rejects duplicate document indices", async () => {
  const provider = new OpenRouterEmbeddingProvider("router-test-key");
  mockTransport(provider, () => Response.json({ data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector(1) }] }));
  await expect(provider.embedDocuments(["one", "two"], { title: "notes.md" })).rejects.toBeInstanceOf(EmbeddingProviderError);
});

test("OpenRouter model changes reindex existing files and resume after restart", async () => {
  const { ctx, db, s3 } = createTestContext();
  const sqlite = (db as any).$client as Database;
  const provider = new OpenRouterEmbeddingProvider("router-test-key");
  const changed = new OpenRouterEmbeddingProvider("router-test-key", "openai/text-embedding-3-large");
  const status = () => (sqlite.prepare("SELECT embedding_status AS status FROM files WHERE path = '/cats.md'").get() as { status: string }).status;
  for (const p of [provider, changed]) {
    mockTransport(p, async (request) => {
      const { input } = await request.json();
      const texts = typeof input === "string" ? [input] : input;
      return Response.json({ data: texts.map((_: string, index: number) => ({ index, embedding: vector() })) });
    });
  }
  try {
    await write(ctx, { path: "/cats.md", content: "Cats are small furry pets." });
    expect(await prepareEmbeddingMigrationWithWarmup(sqlite, provider)).toBe(true);
    expect((await runPendingEmbeddings(db, s3, provider)).indexed).toBe(1);
    expect(status()).toBe("indexed");
    expect(await prepareEmbeddingMigrationWithWarmup(sqlite, provider)).toBe(false);
    expect(embeddingFormat(changed)).not.toBe(embeddingFormat(provider));
    expect(await prepareEmbeddingMigrationWithWarmup(sqlite, changed)).toBe(true);
    expect(status()).toBe("pending");
    // A second startup sees the same format but still resumes pending work.
    expect(await prepareEmbeddingMigrationWithWarmup(sqlite, changed)).toBe(true);
    expect((await runPendingEmbeddings(db, s3, changed)).indexed).toBe(1);
    expect((await vecSearch({ ...ctx, embeddingProvider: changed }, { query: "pets" })).results[0].path).toBe("/cats.md");

    mockTransport(provider, () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }));
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await prepareEmbeddingMigrationWithWarmup(sqlite, provider)).toBe(false);
      expect(status()).toBe("indexed");
      expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'embedding_format'").get()).toEqual({ value: embeddingFormat(changed) });
    } finally {
      error.mockRestore();
    }
  } finally {
    sqlite.close();
  }
});
