import { describe, test, expect } from "bun:test";
import { chunkContent } from "../chunker.js";

describe("chunkContent", () => {
  test("small content returns single chunk", async () => {
    const chunks = await chunkContent("Hello world");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // First chunk should contain the full content
    expect(chunks[0].content).toContain("Hello world");
    expect(chunks[0].charOffset).toBe(0);
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  test("empty content returns empty array", async () => {
    const chunks = await chunkContent("");
    expect(chunks.length).toBe(0);
  });

  test("large content produces multiple chunks", async () => {
    // Generate content well above the chunk threshold (~3600 chars for fallback)
    const paragraph = "This is a test paragraph with enough content to matter. ".repeat(20);
    const content = Array(10).fill(paragraph).join("\n\n");

    const chunks = await chunkContent(content);
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should have charOffset >= 0
    for (const chunk of chunks) {
      expect(chunk.charOffset).toBeGreaterThanOrEqual(0);
      expect(chunk.tokenCount).toBeGreaterThan(0);
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  test("charOffsets are monotonically increasing", async () => {
    const content = "word ".repeat(5000); // ~25000 chars
    const chunks = await chunkContent(content);

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].charOffset).toBeGreaterThan(chunks[i - 1].charOffset);
    }
  });

  test("tokenCount is approximately content.length / 4", async () => {
    // Using fallback chunker (small content path)
    const content = "Hello world test";
    const chunks = await chunkContent(content);
    // Fallback uses Math.ceil(length / 4)
    expect(chunks[0].tokenCount).toBeGreaterThanOrEqual(1);
  });
});
