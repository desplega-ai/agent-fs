import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EmbeddingGemmaProvider } from "../search/embeddings/embeddinggemma.js";
import { EmbeddingProviderError } from "../errors.js";

const home = process.env.AGENT_FS_TEST_EMBEDDINGGEMMA_HOME;
const originalHome = process.env.AGENT_FS_HOME;
let provider: EmbeddingGemmaProvider;

beforeAll(() => {
  if (!home) return;
  process.env.AGENT_FS_HOME = home;
  provider = new EmbeddingGemmaProvider();
});

afterAll(async () => {
  if (!home) return;
  await provider.dispose();
  if (originalHome === undefined) delete process.env.AGENT_FS_HOME;
  else process.env.AGENT_FS_HOME = originalHome;
});

describe.skipIf(!home)("EmbeddingGemma 2 cached model", () => {
  test("returns 768 dimensions with unit norm", async () => {
    const vector = await provider.embedQuery("a friendly cat");
    expect(vector).toHaveLength(768);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
  }, 120_000);

  test("ranks a cat document above a car document", async () => {
    const query = await provider.embedQuery("a small furry companion that meows");
    const [cat, car] = await provider.embedDocuments([
      "Cats are playful household pets. Kittens purr and sleep on cushions.",
      "Automobile engines need oil changes. Brakes and tires require maintenance.",
    ], { title: "notes.md" });
    const dot = (vector: number[]) => query.reduce((sum, value, i) => sum + value * vector[i], 0);
    expect(dot(cat)).toBeGreaterThan(dot(car));
  }, 120_000);

  test("ranks a red circle above a blue square", async () => {
    const { createCanvas } = await import("@napi-rs/canvas");
    const images: Uint8Array[] = [];
    for (const circle of [true, false]) {
      const canvas = createCanvas(512, 512);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 512, 512);
      ctx.fillStyle = circle ? "red" : "blue";
      if (circle) {
        ctx.beginPath();
        ctx.arc(256, 256, 180, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(76, 76, 360, 360);
      }
      images.push(new Uint8Array(await canvas.encode("png")));
    }
    const query = await provider.embedQuery("a red circle");
    const [circle, square] = await provider.embedParts(images.map((data) => ({ mime: "image/png", data })));
    const dot = (vector: number[]) => query.reduce((sum, value, i) => sum + value * vector[i], 0);
    expect(circle).toHaveLength(768);
    expect(square).toHaveLength(768);
    expect(dot(circle)).toBeGreaterThan(dot(square));
  }, 120_000);

  test("keeps the event loop responsive during document embedding and rejects more than 8192 tokens", async () => {
    const text = "The cat sleeps on a warm cushion. ".repeat(200);
    let last = performance.now();
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 10);
    let vector: number[];
    try {
      [vector] = await provider.embedDocuments([text], { title: "cats.md" });
      await Bun.sleep(20);
    } finally {
      clearInterval(timer);
    }
    console.log(`EmbeddingGemma worker document max event-loop gap: ${maxGap.toFixed(1)} ms (${ticks} ticks)`);
    expect(ticks).toBeGreaterThan(0);
    expect(maxGap).toBeLessThan(200);
    expect(vector).toHaveLength(768);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
    await expect(provider.embedQuery(text.repeat(6))).rejects.toBeInstanceOf(EmbeddingProviderError);
  }, 120_000);
});
