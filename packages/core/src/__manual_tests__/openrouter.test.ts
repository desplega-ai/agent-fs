import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createEmbeddingProvider } from "../search/embeddings/index.js";
import { createTestContext } from "../test-utils.js";
import { write } from "../ops/write.js";
import { vecSearch } from "../ops/vec-search.js";
import { indexFileEmbeddings, readCurrentVersion } from "../search/pipeline.js";

// Opt in explicitly: having a key in the shell must not make the unit suite spend money.
const enabled = process.env.AGENT_FS_TEST_OPENROUTER === "1";

describe.skipIf(!enabled)("OpenRouter live embeddings", () => {
  test("embeds batches and retrieves an indexed file by meaning", async () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for the live test");
    const provider = await createEmbeddingProvider({ provider: "openrouter", model: "", apiKey });
    const documents = [
      { path: "/cats.md", content: "Domestic cats are furry pets that purr, chase mice and sleep on sofas." },
      { path: "/cars.md", content: "Car engines burn fuel to power vehicles. Mechanics replace oil filters and spark plugs." },
    ];
    const vectors = await provider.embedDocuments(documents.map(d => d.content), { title: "test.md" });
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(768);
      expect(vector.every(Number.isFinite)).toBe(true);
    }

    const { ctx, db, driveId } = createTestContext();
    try {
      for (const document of documents) {
        await write(ctx, document);
        const version = readCurrentVersion(db, { path: document.path, driveId }) ?? null;
        expect(await indexFileEmbeddings(db, provider, { ...document, driveId, version })).toBe("indexed");
      }
      const found = await vecSearch({ ...ctx, embeddingProvider: provider }, { query: "Which animal makes a purring sound?" });
      expect(found.results[0].path).toBe("/cats.md");
      expect(found.results[0].score).toBeGreaterThan(found.results[1].score);
    } finally {
      ((db as any).$client as Database).close();
    }
  }, 120_000);
});
