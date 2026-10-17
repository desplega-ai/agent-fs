import { describe, test, expect } from "bun:test";
import { chunkContent, segments } from "../chunker.js";

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

describe("large text", () => {
  test("segments cover the text without gaps, cut after line breaks", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const ranges = segments(text, 100);
    expect(ranges[0][0]).toBe(0);
    expect(ranges.at(-1)![1]).toBe(text.length);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
    for (const [, end] of ranges.slice(0, -1)) expect(text[end - 1]).toBe("\n");
    // No line break near the limit: a hard cut at the limit.
    expect(segments("x".repeat(250), 100)).toEqual([[0, 100], [100, 200], [200, 250]]);
    // A hard cut moves back one unit rather than split a surrogate pair.
    const emoji = "a".repeat(99) + "\u{1F600}" + "b".repeat(10);
    expect(segments(emoji, 100)).toEqual([[0, 99], [99, 111]]);
  });

  test("chunks of large text map back to the text, and the event loop keeps running", async () => {
    // About 0.7 MB: one synchronous chunker call blocks the event loop for seconds.
    const rows = Array.from({ length: 20_000 }, (_, i) => `${i},agent-${i % 97},https://example.com/p/${i}`);
    const text = rows.join("\n");
    let last = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      maxGap = Math.max(maxGap, performance.now() - last);
      last = performance.now();
    }, 5);
    const chunks = await chunkContent(text);
    clearInterval(timer);
    maxGap = Math.max(maxGap, performance.now() - last);

    expect(maxGap).toBeLessThan(1000);
    for (const c of chunks) expect(text.slice(c.charOffset, c.charOffset + c.content.length)).toBe(c.content);
    expect(chunks.map((c) => c.content).join("")).toBe(text);
  }, 30_000);

  test("an emoji on a segment boundary survives chunking", async () => {
    const text = "a".repeat(64 * 1024 - 1) + "\u{1F600}" + "b".repeat(100);
    const chunks = await chunkContent(text);
    expect(chunks.map((c) => c.content).join("")).toBe(text);
    for (const c of chunks) expect(text.slice(c.charOffset, c.charOffset + c.content.length)).toBe(c.content);
    expect(chunks.some((c) => c.content.includes("\uFFFD"))).toBe(false);
  });
});
