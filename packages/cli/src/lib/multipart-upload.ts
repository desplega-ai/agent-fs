import type { ApiClient } from "../api-client.js";

/** Above this size `write` sends the file straight to storage in parts. */
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
const CONCURRENCY = 4;
const PART_ATTEMPTS = 5;
const PART_TIMEOUT_MS = 5 * 60_000;

export interface MultipartUploadOptions {
  message?: string;
  expectedVersion?: number;
  onPart?: (done: number, total: number) => void;
  /** Test hook: base retry delay. */
  retryDelayMs?: number;
}

/**
 * Upload `blob` through upload-start / upload-part-url / upload-finish. Each
 * part gets a fresh presigned URL per attempt and is retried on its own, so a
 * dropped connection costs one part, not the whole file. The blob is read one
 * part at a time, never whole. When a part or upload-finish fails, the upload is
 * aborted so its parts do not stay in storage.
 */
export async function uploadMultipart(
  client: ApiClient,
  orgId: string,
  driveId: string,
  path: string,
  blob: Blob,
  opts: MultipartUploadOptions = {}
): Promise<any> {
  const op = (name: string, params: Record<string, unknown>, timeoutMs?: number) =>
    client.callOp(orgId, name, { driveId, path, ...params }, { timeoutMs });
  const start = await op("upload-start", { size: blob.size });
  const { uploadId, partSize, partCount } = start as { uploadId: string; partSize: number; partCount: number };
  const localHash = sha256(blob);
  localHash.catch(() => {});

  const abort = async (err: unknown): Promise<never> => {
    // The server aborts under the path lock, so after an upload-finish timeout it
    // waits for that finish and then finds nothing to abort: a committed file stays.
    await op("upload-abort", { uploadId }).catch(() => {});
    throw err;
  };

  let next = 1;
  let done = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next <= partCount) {
      const partNumber = next++;
      try {
        await uploadPart(op, uploadId, blob.slice((partNumber - 1) * partSize, partNumber * partSize), partNumber, opts.retryDelayMs ?? 1000, () => failed);
      } catch (err) {
        failed = true;
        throw err;
      }
      opts.onPart?.(++done, partCount);
    }
  };
  // Settle every worker before aborting: a part PUT still in flight during the
  // abort can land after it and stay in storage.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, partCount) }, worker));
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (rejected) await abort(rejected.reason);

  // The server reads the object back to hash it: allow 1 s per 10 MiB on top of a minute.
  const result = await op(
    "upload-finish",
    { uploadId, size: blob.size, message: opts.message, expectedVersion: opts.expectedVersion },
    60_000 + Math.ceil(blob.size / (10 * 1024 * 1024)) * 1000
  ).catch(abort);
  if (result.contentHash !== (await localHash)) {
    throw new Error(`Stored file ${result.path} (version ${result.version}) does not match the local bytes: sha256 ${result.contentHash}, expected ${await localHash}. Upload it again.`);
  }
  return result;
}

async function uploadPart(
  op: (name: string, params: Record<string, unknown>) => Promise<any>,
  uploadId: string,
  body: Blob,
  partNumber: number,
  retryDelayMs: number,
  stopped: () => boolean
): Promise<void> {
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    // Another part already failed for good: no more retries, the upload is aborted.
    if (attempt > 1 && stopped()) break;
    attempts = attempt;
    try {
      // A fresh URL per attempt: the old one may have expired during a slow retry.
      const { url } = await op("upload-part-url", { uploadId, partNumber });
      const res = await fetch(url, { method: "PUT", body, signal: AbortSignal.timeout(PART_TIMEOUT_MS) });
      if (res.ok) {
        await res.arrayBuffer();
        return;
      }
      lastError = new Error(`storage answered ${res.status} for part ${partNumber}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < PART_ATTEMPTS) await Bun.sleep(retryDelayMs * 2 ** (attempt - 1));
  }
  throw new Error(`Part ${partNumber} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function sha256(blob: Blob): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of blob.stream() as unknown as AsyncIterable<Uint8Array>) hasher.update(chunk);
  return hasher.digest("hex");
}
