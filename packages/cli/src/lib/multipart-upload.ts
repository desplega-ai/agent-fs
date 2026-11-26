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
 * part at a time, never whole.
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

  try {
    let next = 1;
    let done = 0;
    const worker = async () => {
      while (next <= partCount) {
        const partNumber = next++;
        await uploadPart(op, uploadId, blob.slice((partNumber - 1) * partSize, partNumber * partSize), partNumber, opts.retryDelayMs ?? 1000);
        opts.onPart?.(++done, partCount);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, partCount) }, worker));
  } catch (err) {
    await op("upload-abort", { uploadId }).catch(() => {});
    throw err;
  }

  // The server reads the object back to hash it: allow 1 s per 10 MiB on top of a minute.
  const result = await op(
    "upload-finish",
    { uploadId, size: blob.size, message: opts.message, expectedVersion: opts.expectedVersion },
    60_000 + Math.ceil(blob.size / (10 * 1024 * 1024)) * 1000
  );
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
  retryDelayMs: number
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
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
  throw new Error(`Part ${partNumber} failed after ${PART_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function sha256(blob: Blob): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of blob.stream() as unknown as AsyncIterable<Uint8Array>) hasher.update(chunk);
  return hasher.digest("hex");
}
