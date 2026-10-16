import { describe, expect, test } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createUser, listDrives, listUserOrgs } from "@/core";
import type { EmbeddingProvider } from "@/core";
import { createApp } from "../app.js";

function providerReturning(vector: () => number[]): EmbeddingProvider {
  return {
    name: "bad",
    dimensions: 768,
    async embed() {
      return vector();
    },
    async embedBatch(texts) {
      return texts.map(vector);
    },
  };
}

const vectorOf = (value: (i: number) => number) => Array.from({ length: 768 }, (_, i) => value(i));

describe("invalid query embeddings", () => {
  test.each([
    ["zero", () => vectorOf(() => 0)],
    ["NaN", () => vectorOf((i) => (i === 0 ? NaN : 1))],
    ["Infinity", () => vectorOf((i) => (i === 0 ? Infinity : 1))],
    ["Float32 overflow", () => vectorOf((i) => (i === 0 ? 1e39 : 1))],
    ["wrong-dimension", () => [3, 4]],
  ])("a %s query vector returns 502 EMBEDDING_PROVIDER_ERROR", async (_, vector) => {
    const db = createTestDb();
    const app = createApp(db, new MockS3Client(), providerReturning(vector));
    const { user, apiKey } = createUser(db, { email: "embed@example.com" });
    const orgId = listUserOrgs(db, user.id)[0].id;
    const driveId = listDrives(db, orgId)[0].id;

    for (const op of ["vec-search", "search"]) {
      const response = await app.request(`/orgs/${orgId}/ops`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op, driveId, query: "cats" }),
      });
      expect(response.status).toBe(502);
      expect((await response.json()).error).toBe("EMBEDDING_PROVIDER_ERROR");
    }
  });
});
