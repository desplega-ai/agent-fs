import { embeddingGemmaWorker } from "./embeddings/embeddinggemma-worker.js";
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
  return canvasAvailable ??= embeddingGemmaWorker.call("canvas", {}).catch((err) => {
    if (err instanceof Error && err.name === "CanvasImportError") {
      console.warn("PDF page images unavailable. Install canvas with: bun add -g @napi-rs/canvas@1.0.11");
    } else {
      canvasAvailable = undefined;
      console.warn(`PDF page image worker unavailable: ${err instanceof Error ? err.message : err}`);
    }
    return false;
  });
}

/** Each result keeps its original page number when another page fails. */
export function renderPdfPages(
  bytes: Uint8Array,
  n: number
): Promise<{ page: number; data: Uint8Array }[]> {
  return embeddingGemmaWorker.call("pdf", { bytes, n });
}
