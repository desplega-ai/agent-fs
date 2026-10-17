import { describe, expect, mock, spyOn, test } from "bun:test";
import { EmbeddingGemmaProvider, loadTransformers, INSTALL_HINT, TRANSFORMERS_VERSION } from "../embeddings/embeddinggemma.js";
import { EmbeddingGemmaWorker, embeddingGemmaWorker, type WorkerRequest, type WorkerReply } from "../embeddings/embeddinggemma-worker.js";
import { startWorker, EmbeddingGemmaRuntime, type WorkerScope, type RuntimeOptions } from "../embeddings/embeddinggemma-runtime.mjs";
import { EmbeddingProviderError } from "../../errors.js";
import { EmbeddingInitializationError } from "../embeddings/provider.js";

class FakeWorker extends EventTarget {
  onmessage: ((event: { data: WorkerReply }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage = mock((_message: WorkerRequest) => {});
  terminate = mock(() => {});
  ref = mock(() => {});
  unref = mock(() => {});
  reply(id: number, result: WorkerReply["result"]) { this.onmessage?.({ data: { id, result } }); }
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = new EmbeddingGemmaWorker(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { client, workers, provider: new EmbeddingGemmaProvider(client) };
}

const options: RuntimeOptions = { paths: {}, conflict: null, cacheDir: "", version: TRANSFORMERS_VERSION, hint: INSTALL_HINT };

describe("EmbeddingGemma worker proxy", () => {
  test("names missing transformers and starts no worker", async () => {
    const resolve = spyOn(Bun, "resolveSync").mockImplementation(() => { throw new Error("not installed"); });
    const call = spyOn(embeddingGemmaWorker, "call");
    const create = spyOn(globalThis, "Worker");
    try {
      expect(await loadTransformers()).toEqual({
        reason: "missing (@huggingface/transformers: not installed)", hint: INSTALL_HINT,
      });
      expect(call).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
      call.mockRestore();
      create.mockRestore();
    }
  });

  test("supports four image types and rejects unsupported parts before posting", async () => {
    const { provider, workers } = setup();
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) expect(provider.supportsMime(mime)).toBe(true);
    for (const mime of ["image/svg+xml", "application/pdf", "text/plain"]) expect(provider.supportsMime(mime)).toBe(false);
    await expect(provider.embedParts([{ mime: "image/svg+xml", data: new Uint8Array([1]) }])).rejects.toThrow("Unsupported embedding MIME type");
    expect(await provider.embedParts([])).toEqual([]);
    expect(workers).toHaveLength(0);
  });

  test("finishes a CLI request and exits with an idle worker", async () => {
    const modulePath = new URL("../embeddings/embeddinggemma-worker.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "-e", `
      import { EmbeddingGemmaWorker } from ${JSON.stringify(modulePath)};
      const client = new EmbeddingGemmaWorker(() => new Worker(URL.createObjectURL(new Blob([
        'self.onmessage = ({ data }) => { if (data.id) postMessage({ id: data.id, result: [1] }); };'
      ], { type: "application/javascript" }))));
      console.log(JSON.stringify(await client.call("query", { text: "one" })));
    `], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 3000);
    try {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("[1]\n");
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  });

  test("sends one document or image per job and preserves query inputs", async () => {
    const { provider, workers } = setup();
    const documents = provider.embedDocuments(["first", "second"], { title: "notes.md" });
    const worker = workers[0];
    expect(worker.unref).toHaveBeenCalledTimes(1);
    expect(worker.ref).toHaveBeenCalledTimes(1);
    expect(worker.postMessage.mock.calls[0][0]).toMatchObject({ type: "open" });
    expect(worker.postMessage.mock.calls[1][0]).toEqual({ id: 1, type: "document", text: "first", title: "notes.md" });
    worker.reply(1, [1]);
    await Bun.sleep(0);
    expect(worker.postMessage.mock.calls[2][0]).toMatchObject({ id: 2, type: "document", text: "second" });
    worker.reply(2, [2]);
    expect(await documents).toEqual([[1], [2]]);
    expect(worker.unref).toHaveBeenCalledTimes(3);
    const query = provider.embedQuery("cats");
    expect(worker.postMessage.mock.calls[3][0]).toEqual({ id: 3, type: "query", text: "cats" });
    worker.reply(3, [3]);
    expect(await query).toEqual([3]);
    const part = { mime: "image/png", data: new Uint8Array([1]) };
    const image = provider.embedParts([part]);
    expect(worker.postMessage.mock.calls[4][0]).toEqual({ id: 4, type: "image", part });
    worker.reply(4, [4]);
    expect(await image).toEqual([[4]]);
  });

  test.each([EmbeddingProviderError, EmbeddingInitializationError])("rebuilds %p across the boundary", async (ErrorClass) => {
    const { provider, workers } = setup();
    const result = provider.embedQuery("error");
    const original = ErrorClass === EmbeddingProviderError ? new EmbeddingProviderError("cause") : new EmbeddingInitializationError(new Error("cause"));
    workers[0].onmessage?.({ data: { id: 1, error: { name: original.name, message: original.message, cause: "cause" } } });
    await expect(result).rejects.toBeInstanceOf(ErrorClass);
    await expect(result).rejects.toMatchObject({ message: original.message });
  });

  test.each(["error", "close", "postMessage"])("rejects every pending call after %s and restarts", async (failure) => {
    const { provider, workers } = setup();
    const first = provider.embedQuery("one");
    const second = provider.embedQuery("two");
    const rejected = Promise.allSettled([first, second]);
    const worker = workers[0];
    if (failure === "close") worker.dispatchEvent(new Event("close"));
    else if (failure === "error") worker.onerror?.({ message: "crashed" });
    else {
      worker.postMessage.mockImplementation(() => { throw new Error("dead port"); });
      await expect(provider.embedQuery("three")).rejects.toThrow("dead port");
    }
    for (const result of await rejected) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toContain("EmbeddingGemma worker stopped");
    }
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const retry = provider.embedQuery("retry");
    expect(workers).toHaveLength(2);
    const message = workers[1].postMessage.mock.calls[1][0];
    if (!("id" in message)) throw new Error("Expected a worker job");
    worker.onmessage?.({ data: { id: message.id, result: [99] } });
    workers[1].reply(message.id, [1]);
    expect(await retry).toEqual([1]);
  });

  test("disposes the runtime before terminating the worker", async () => {
    const { provider, workers } = setup();
    const query = provider.embedQuery("warmup");
    workers[0].reply(1, [1]);
    await query;
    const disposed = provider.dispose();
    expect(workers[0].postMessage.mock.calls[2][0]).toEqual({ id: 2, type: "dispose" });
    workers[0].reply(2, undefined);
    await disposed;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    await provider.dispose();
    expect(workers).toHaveLength(1);
  });
});

describe("EmbeddingGemma worker protocol", () => {
  test("runs one job at a time and puts queries before queued document and image work", async () => {
    const order: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { started = resolve; });
    const runtime = Object.assign(new EmbeddingGemmaRuntime(options), {
      async embedDocuments([text]: string[]) {
        order.push(text);
        if (text === "first") { started(); await gate; }
        return [[1]];
      },
      async embedQuery(text: string) { order.push(text); return [2]; },
      async embedParts() { order.push("image"); return [[3]]; },
    });
    const messages: WorkerReply[] = [];
    let complete!: () => void;
    const done = new Promise<void>((resolve) => { complete = resolve; });
    const scope: WorkerScope = { onmessage: null, postMessage(message) { messages.push(message); if (messages.length === 5) complete(); } };
    startWorker(scope, runtime);
    const send = (data: WorkerRequest) => scope.onmessage!({ data });
    send({ id: 1, type: "document", text: "first", title: "notes" });
    await running;
    send({ id: 2, type: "document", text: "second", title: "notes" });
    send({ id: 3, type: "image", part: { mime: "image/png", data: new Uint8Array([1]) } });
    send({ id: 4, type: "query", text: "query one" });
    send({ id: 5, type: "query", text: "query two" });
    await Bun.sleep(5);
    expect(order).toEqual(["first"]);
    release();
    await done;
    expect(order).toEqual(["first", "query one", "query two", "second", "image"]);
    expect(messages.map((m) => m.id)).toEqual([1, 4, 5, 2, 3]);
  });

  test("serializes errors and continues with the next job", async () => {
    const scope: WorkerScope = { onmessage: null, postMessage() {} };
    const replies: WorkerReply[] = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    scope.postMessage = (message) => { replies.push(message); if (replies.length === 2) finish(); };
    startWorker(scope, Object.assign(new EmbeddingGemmaRuntime(options), {
      async embedQuery() { throw new EmbeddingProviderError("too many tokens"); },
      async embedDocuments() { return [[1]]; },
    }));
    scope.onmessage!({ data: { id: 1, type: "query", text: "bad" } });
    scope.onmessage!({ data: { id: 2, type: "document", text: "ok", title: "notes" } });
    await done;
    expect(replies[0]).toMatchObject({ id: 1, error: { name: "EmbeddingProviderError", message: "too many tokens" } });
    expect(replies[1]).toEqual({ id: 2, result: [1] });
  });
});
