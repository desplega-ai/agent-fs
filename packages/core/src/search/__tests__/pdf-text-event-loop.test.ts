import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { extractPdfText } from "../pdf.js";

/** One-page PDF whose only content stream inflates to `decodedBytes` of text-free operators. */
function inflatingPdf(decodedBytes: number): Uint8Array {
  const unit = "q Q\n";
  const stream = deflateSync(Buffer.from(unit.repeat(Math.ceil(decodedBytes / unit.length))), { level: 9 });
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (part: string | Buffer) => {
    const buf = typeof part === "string" ? Buffer.from(part, "latin1") : part;
    chunks.push(buf);
    size += buf.length;
  };
  const obj = (n: number, ...body: (string | Buffer)[]) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    body.forEach(push);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>");
  obj(4, `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, stream, "\nendstream");
  const xref = size;
  push(`xref\n0 5\n0000000000 65535 f \n${[1, 2, 3, 4].map((n) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

/** Runs `fn` while a 5 ms interval records the longest gap between ticks. */
async function longestTickGap(fn: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  try {
    await fn();
    longest = Math.max(longest, performance.now() - last);
  } finally {
    clearInterval(timer);
  }
  return longest;
}

describe("PDF text extraction and the event loop", () => {
  test("control: the timer probe sees a short gap when nothing blocks", async () => {
    expect(await longestTickGap(() => Bun.sleep(100))).toBeLessThan(250);
  });

  test("control: the inflating fixture is small and has no text", async () => {
    const bytes = inflatingPdf(16 * 1024 * 1024);
    expect(bytes.length).toBeLessThan(32 * 1024);
    expect((await extractPdfText(bytes)).text).toBe("");
  }, 60_000);

  test("a small PDF with a large content stream does not block the event loop", async () => {
    const bytes = inflatingPdf(16 * 1024 * 1024);
    expect(await longestTickGap(() => extractPdfText(bytes))).toBeLessThan(500);
  }, 60_000);

  test("extraction past the time limit stops and returns empty text", async () => {
    const bytes = inflatingPdf(64 * 1024 * 1024);
    const started = performance.now();
    expect(await extractPdfText(bytes, 200)).toEqual({ text: "", pageStarts: [] });
    expect(performance.now() - started).toBeLessThan(2_000);
    const text = new Uint8Array(await Bun.file(new URL("fixtures/text.pdf", import.meta.url)).arrayBuffer());
    expect((await extractPdfText(text)).text).toContain("quarterly aurora invoice");
  }, 10_000);
});
