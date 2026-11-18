import { embeddingGemmaWorker } from "./embeddings/embeddinggemma-worker.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { MAX_EMBED_CHARS } from "./pipeline.js";

// Plain JavaScript in a string so it survives bundling into the single-file CLI.
const TEXT_WORKER_SOURCE = `
self.onmessage = async ({ data }) => {
  let pdf;
  try {
    const { getDocumentProxy } = await import(data.unpdf);
    pdf = await getDocumentProxy(data.bytes, { isEvalSupported: false, verbosity: 0 });
    let text = "";
    const pageStarts = [];
    // See indexFileEmbeddings.pageStarts: capped PDFs still end indexed and avoid repeated boot backfills.
    for (let n = 1; n <= pdf.numPages && text.length < data.maxChars; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      const pageText = content.items
        .map((item) => "str" in item ? item.str.replace(/\\s+/g, " ") + (item.hasEOL ? "\\n" : " ") : "")
        .join("")
        .replace(/[^\\S\\n]+/g, " ")
        .replace(/ *\\n */g, "\\n")
        .trim();
      if (n > 1) text += "\\n\\n".slice(0, data.maxChars - text.length);
      pageStarts.push(text.length);
      text += pageText.slice(0, data.maxChars - text.length);
    }
    postMessage({ text, pageStarts });
  } catch (err) {
    postMessage({ error: String(err && err.message || err) });
  } finally {
    // The worker is reused, so free the document's memory.
    await pdf?.loadingTask.destroy().catch((err) => {
      console.error("[agent-fs] PDF cleanup failed: " + String(err && err.message || err).replace(/[\\r\\n]+/g, " "));
    });
  }
};
`;

/** Wall-clock limit for one PDF's text extraction. */
export const PDF_TEXT_TIMEOUT_MS = 60_000;
const MAX_PDF_TEXT_WORKERS = 2;

let textWorkerUrl: string | undefined;
const idleTextWorkers: Worker[] = [];
let runningTextWorkers = 0;
const waitingForTextWorker: (() => void)[] = [];

/**
 * Extracts PDF text for FTS and embeddings, with offsets for each page.
 * pdf.js parses a page without yielding, so this runs on a worker thread that
 * is stopped after `timeoutMs`, and at most two run at once. A worker that
 * finishes in time is kept for the next call.
 * Failed or timed-out extraction returns empty text so file operations can still succeed.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  timeoutMs = PDF_TEXT_TIMEOUT_MS
): Promise<{ text: string; pageStarts: number[] }> {
  if (runningTextWorkers >= MAX_PDF_TEXT_WORKERS) await new Promise<void>((resolve) => waitingForTextWorker.push(resolve));
  else runningTextWorkers++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: (() => void) | undefined;
  try {
    const unpdf = Bun.resolveSync("unpdf", import.meta.dir);
    textWorkerUrl ??= URL.createObjectURL(new Blob([TEXT_WORKER_SOURCE], { type: "application/javascript" }));
    const started = idleTextWorkers.pop() ?? new Worker(textWorkerUrl);
    worker = started;
    (started as Worker & { ref(): void }).ref();
    const result = await new Promise<{ text: string; pageStarts: number[]; error?: string }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      started.onmessage = ({ data }) => resolve(data);
      started.onerror = (event) => reject(new Error(event.message || "worker error"));
      stopped = () => reject(new Error("worker stopped"));
      started.addEventListener("close", stopped);
      // Copy the bytes because they are transferred to the worker.
      const copy = bytes.slice();
      started.postMessage({ unpdf, bytes: copy, maxChars: MAX_EMBED_CHARS }, [copy.buffer]);
    });
    started.removeEventListener("close", stopped!);
    // Idle workers must not keep CLI commands alive.
    (started as Worker & { unref(): void }).unref();
    idleTextWorkers.push(started);
    worker = undefined;
    if (result.error !== undefined) throw new Error(result.error);
    return { text: result.text.trim() === "" ? "" : result.text, pageStarts: result.pageStarts };
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, " ");
    console.error(`[agent-fs] PDF text extraction failed: ${message}`);
    return { text: "", pageStarts: [] };
  } finally {
    clearTimeout(timer);
    worker?.terminate();
    // Hand the slot to the next caller, or free it.
    const next = waitingForTextWorker.shift();
    if (next) next();
    else runningTextWorkers--;
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
