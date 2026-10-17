import { join } from "node:path";
import { getHome } from "../../config.js";
import { EmbeddingProviderError } from "../../errors.js";
import { EmbeddingInitializationError } from "./provider.js";
import { TRANSFORMERS_VERSION, INSTALL_HINT, type TransformersResult } from "./embeddinggemma.js";
import source from "./embeddinggemma-runtime.mjs" with { type: "text" };
import type { EmbeddingPart } from "./provider.js";
import type { RuntimeOptions } from "./embeddinggemma-runtime.mjs";

export interface WorkerJobs {
  probe: { params: {}; result: TransformersResult };
  query: { params: { text: string }; result: number[] };
  document: { params: { text: string; title: string }; result: number[] };
  image: { params: { part: EmbeddingPart }; result: number[] };
  pdf: { params: { bytes: Uint8Array; n: number }; result: { page: number; data: Uint8Array }[] };
  canvas: { params: {}; result: true };
  dispose: { params: {}; result: void };
}

export type WorkerRequest = { type: "open"; options: RuntimeOptions } | {
  [K in keyof WorkerJobs]: { id: number; type: K } & WorkerJobs[K]["params"]
}[keyof WorkerJobs];

export type WorkerReply = {
  id: number;
  result?: WorkerJobs[keyof WorkerJobs]["result"];
  error?: { name: string; message: string; cause: string };
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class EmbeddingGemmaWorker {
  private worker: Worker | null = null;
  private url: string | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private createWorker = (url: string) => new Worker(url)) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const paths: RuntimeOptions["paths"] = {};
    for (const [key, name] of Object.entries({
      transformers: "@huggingface/transformers", unpdf: "unpdf", canvas: "@napi-rs/canvas",
    }) as [keyof RuntimeOptions["paths"], string][]) {
      try { paths[key] = Bun.resolveSync(name, import.meta.dir); } catch {}
    }
    const url = URL.createObjectURL(new Blob([source, "\nstartWorker(self);"], { type: "application/javascript" }));
    let worker: Worker;
    try {
      worker = this.createWorker(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    this.worker = worker;
    this.url = url;
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (!this.pending.size) (worker as Worker & { unref(): void }).unref();
      if (data.error) {
        const { name, message, cause } = data.error;
        const error = name === "EmbeddingProviderError" ? new EmbeddingProviderError(message)
          : name === "EmbeddingInitializationError" ? new EmbeddingInitializationError(new Error(cause))
          : Object.assign(new Error(message), { name });
        pending.reject(error);
      } else {
        pending.resolve(data.result);
      }
    };
    worker.onerror = (event) => this.fail(worker, event.message || "error");
    worker.addEventListener("close", () => this.fail(worker, "closed"));
    worker.addEventListener("messageerror", () => this.fail(worker, "invalid message"));
    // Idle workers must not keep CLI commands alive.
    (worker as Worker & { unref(): void }).unref();
    try {
      const open: WorkerRequest = {
        type: "open", options: { paths, cacheDir: join(getHome(), "models"), version: TRANSFORMERS_VERSION, hint: INSTALL_HINT },
      };
      worker.postMessage(open);
    } catch (err) {
      this.fail(worker, String(err));
      throw err;
    }
    return worker;
  }

  private fail(worker: Worker, reason: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    const error = new Error(`EmbeddingGemma worker stopped: ${reason}`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    worker.terminate();
  }

  async call<K extends keyof WorkerJobs>(type: K, params: WorkerJobs[K]["params"]): Promise<WorkerJobs[K]["result"]> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise<WorkerJobs[K]["result"]>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as WorkerJobs[K]["result"]), reject });
      try {
        (worker as Worker & { ref(): void }).ref();
        worker.postMessage({ id, type, ...params });
      } catch (err) {
        this.fail(worker, String(err));
      }
    });
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      await this.call("dispose", {});
    } finally {
      this.fail(worker, "disposed");
    }
  }
}

// The probe, provider, and PDF renderer share one queue and one native runtime.
export const embeddingGemmaWorker = new EmbeddingGemmaWorker();
