import type { EmbeddingProvider } from "./embeddings/provider.js";
import { MAX_EMBED_CHARS } from "./pipeline.js";

/**
 * Extracts PDF text for FTS and embeddings, with offsets for each page.
 * Failed extraction returns empty text so file operations can still succeed.
 */
export async function extractPdfText(
  bytes: Uint8Array
): Promise<{ text: string; pageStarts: number[] }> {
  try {
    const { getDocumentProxy } = await import("unpdf");
    const options = { isEvalSupported: false, verbosity: 0 };
    // Copy the bytes because pdf.js detaches the buffer it receives.
    const pdf = await getDocumentProxy(bytes.slice(), options);
    try {
      let text = "";
      const pageStarts: number[] = [];
      // See indexFileEmbeddings.pageStarts: capped PDFs still end indexed and avoid repeated boot backfills.
      for (let n = 1; n <= pdf.numPages && text.length < MAX_EMBED_CHARS; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => "str" in item ? `${item.str.replace(/\s+/g, " ")}${item.hasEOL ? "\n" : " "}` : "")
          .join("")
          .replace(/[^\S\n]+/g, " ")
          .replace(/ *\n */g, "\n")
          .trim();
        if (n > 1) text += "\n\n".slice(0, MAX_EMBED_CHARS - text.length);
        pageStarts.push(text.length);
        text += pageText.slice(0, MAX_EMBED_CHARS - text.length);
        // pdf.js resolves in microtasks, so this sleep yields to the event loop.
        await Bun.sleep(0);
      }
      return { text: text.trim() === "" ? "" : text, pageStarts };
    } finally {
      try {
        await pdf.loadingTask.destroy();
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, " ");
        console.error(`[agent-fs] PDF cleanup failed: ${message}`);
      }
    }
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, " ");
    console.error(`[agent-fs] PDF text extraction failed: ${message}`);
    return { text: "", pageStarts: [] };
  }
}

export const PDF_PAGE_IMAGES = 3;

let canvasAvailable: Promise<boolean> | undefined;

export function canRenderPdfPages(provider: EmbeddingProvider | null | undefined): Promise<boolean> {
  if (!provider?.supportsMime?.("image/png")) return Promise.resolve(false);
  return canvasAvailable ??= import("@napi-rs/canvas").then(() => true, () => {
    console.warn("PDF page images unavailable. Install canvas with: bun add -g @napi-rs/canvas@1.0.11");
    return false;
  });
}

/** Each result keeps its original page number when another page fails. */
export async function renderPdfPages(
  bytes: Uint8Array,
  n: number
): Promise<{ page: number; data: Uint8Array }[]> {
  const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
  const options = { isEvalSupported: false, verbosity: 0 };
  const pdf = await getDocumentProxy(bytes.slice(), options);
  try {
    const pages: { page: number; data: Uint8Array }[] = [];
    for (let page = 1; page <= Math.min(n, pdf.numPages); page++) {
      try {
        const buffer = await renderPageAsImage(pdf, page, {
          canvasImport: () => import("@napi-rs/canvas"),
          width: 1024,
        });
        pages.push({ page, data: new Uint8Array(buffer) });
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, " ");
        console.error(`[agent-fs] PDF page ${page} rendering failed: ${message}`);
      }
    }
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
