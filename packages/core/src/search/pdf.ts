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
