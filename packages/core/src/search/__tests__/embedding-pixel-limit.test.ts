import { describe, expect, mock, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { EmbeddingGemmaRuntime, imageSize } from "../embeddings/embeddinggemma-runtime.mjs";

// Stored images and PDF pages are rasterized in the shared embedding worker.
// A small file must not turn into a raster much larger than the vision model needs.
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_PDF_PAGE_PIXELS = 1024 * 4096;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

/** A blank 8-bit grayscale PNG. Large blank images compress to a few kilobytes. */
function grayPng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const idat = deflateSync(new Uint8Array((width + 1) * height));
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  return Buffer.concat(parts);
}

/** A one-page PDF with an empty page of the given size in points. */
function pdfWithPage(width: number, height: number): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] >>`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const pngSize = (data: Uint8Array) => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

async function visionRuntime() {
  const { RawImage } = await import("@huggingface/transformers");
  const decoded: number[] = [];
  const runtime = new EmbeddingGemmaRuntime({ paths: {}, cacheDir: "", version: "4.3.1", hint: "" });
  const fromBlob = async (blob: Blob) => {
    const image = await RawImage.fromBlob(blob);
    decoded.push(image.width * image.height);
    return image;
  };
  Object.assign(runtime, {
    _doInitVision: async () => Object.assign(runtime, {
      visionModel: Object.assign(mock(async () => ({ sentence_embedding: { data: new Float32Array(768).fill(0.5) } })), {
        dispose: mock(async () => {}),
      }),
      visionProcessor: mock(async () => ({ pixel_values: true })),
      rawImage: { fromBlob },
    }),
  });
  return { runtime, decoded };
}

function pdfRuntime() {
  const paths = {
    unpdf: Bun.resolveSync("unpdf", import.meta.dir),
    canvas: Bun.resolveSync("@napi-rs/canvas", import.meta.dir),
  };
  return new EmbeddingGemmaRuntime({ paths, cacheDir: "", version: "4.3.1", hint: "" });
}

describe("embedding raster bounds", () => {
  test("reads the declared size of each supported format", async () => {
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(300, 200);
    for (const data of [await canvas.encode("png"), await canvas.encode("jpeg"), await canvas.encode("webp"), await canvas.encode("gif")]) {
      expect(imageSize(data)).toEqual({ width: 300, height: 200 });
    }
    expect(imageSize(await canvas.encode("avif"))).toBeNull();
    expect(imageSize(grayPng(8192, 8192))).toEqual({ width: 8192, height: 8192 });
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  test("control: a normal image decodes and embeds", async () => {
    const { runtime, decoded } = await visionRuntime();
    try {
      expect(await runtime.embedParts([{ mime: "image/png", data: grayPng(64, 64) }])).toHaveLength(1);
      expect(decoded).toEqual([64 * 64]);
    } finally {
      await runtime.dispose();
    }
  });

  test("an image whose header declares too many pixels is rejected before decode", async () => {
    const data = grayPng(8192, 8192);
    expect(data.byteLength).toBeLessThan(1024 * 1024);
    const { runtime, decoded } = await visionRuntime();
    try {
      await expect(runtime.embedParts([{ mime: "image/png", data }])).rejects.toThrow();
      expect(Math.max(0, ...decoded)).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
    } finally {
      await runtime.dispose();
    }
  });

  test("control: a letter-size PDF page renders 1024 pixels wide", async () => {
    const [page] = await pdfRuntime().renderPdfPages(pdfWithPage(612, 792), 1);
    expect(pngSize(page.data)).toEqual({ width: 1024, height: 1325 });
  });

  test("a very tall PDF page renders within the page pixel bound", async () => {
    const pages = await pdfRuntime().renderPdfPages(pdfWithPage(100, 3000), 1);
    expect(pages).toHaveLength(1);
    for (const { data } of pages) {
      const { width, height } = pngSize(data);
      expect(width * height).toBeLessThanOrEqual(MAX_PDF_PAGE_PIXELS);
    }
  });
});
