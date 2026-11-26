import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createTestDb, MockS3Client } from "../../../../core/src/test-utils.js";
import { createApp } from "../../../../server/src/app.js";
import { ApiClient } from "../../api-client.js";
import { uploadMultipart } from "../multipart-upload.js";

// The real daemon app plus a stand-in for storage's presigned part URLs, so the
// CLI uploader runs its whole flow: start, signed part PUTs with retry, finish.
const MiB = 1024 * 1024;
const s3 = new MockS3Client();
let server: ReturnType<typeof Bun.serve>;
let orgId: string;
let driveId: string;
/** Part PUTs to answer 500 before accepting one, by part number. */
const failures = new Map<number, number>();
const signed: number[] = [];

beforeAll(async () => {
  const app = createApp(createTestDb(), s3);
  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/part/")) return app.fetch(req, srv);
      const partNumber = Number(url.searchParams.get("partNumber"));
      const left = failures.get(partNumber) ?? 0;
      if (left > 0) {
        failures.set(partNumber, left - 1);
        await req.arrayBuffer();
        return new Response("slow down", { status: 500 });
      }
      s3.uploadPart(decodeURIComponent(url.pathname.slice("/part/".length)), url.searchParams.get("uploadId")!, partNumber, new Uint8Array(await req.arrayBuffer()));
      return new Response(null, { status: 200 });
    },
  });
  spyOn(s3, "getPresignedUploadPartUrl").mockImplementation(async (key, uploadId, partNumber) => {
    signed.push(partNumber);
    return `${server.url}part/${encodeURIComponent(key)}?uploadId=${uploadId}&partNumber=${partNumber}`;
  });
  const res = await fetch(new URL("/auth/register", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "multipart@example.com" }),
  });
  const body = await res.json();
  orgId = body.orgId;
  process.env.AGENT_FS_API_URL = server.url.origin;
  process.env.AGENT_FS_API_KEY = body.apiKey;
  driveId = (await new ApiClient().getMe()).defaultDriveId!;
});

afterAll(() => {
  server?.stop(true);
  delete process.env.AGENT_FS_API_URL;
  delete process.env.AGENT_FS_API_KEY;
});

test("uploads every part, retries a failed one with a fresh URL, and stores the exact bytes", async () => {
  const bytes = new Uint8Array(65 * MiB + 7);
  for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
  failures.set(2, 2);
  signed.length = 0;
  const parts: number[] = [];

  const result = await uploadMultipart(new ApiClient(), orgId, driveId, "/video.mp4", new Blob([bytes]), {
    message: "big one",
    retryDelayMs: 1,
    onPart: (done) => parts.push(done),
  });

  expect(result).toMatchObject({ version: 1, path: "/video.mp4", size: bytes.length });
  expect(result.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(signed.sort()).toEqual([1, 2, 2, 2, 3]);
  expect(parts).toEqual([1, 2, 3]);
  const stored = await new ApiClient().getRaw(orgId, driveId, "/video.mp4");
  expect(stored.bytes.length).toBe(bytes.length);
  expect(stored.version).toBe(1);
}, 30_000);

test("gives up on a part after five attempts and aborts the upload", async () => {
  failures.set(1, 99);
  const abort = spyOn(s3, "abortMultipartUpload");
  try {
    await expect(
      uploadMultipart(new ApiClient(), orgId, driveId, "/broken.bin", new Blob([new Uint8Array(10)]), { retryDelayMs: 1 })
    ).rejects.toThrow("Part 1 failed after 5 attempts: storage answered 500");
    expect(abort).toHaveBeenCalledTimes(1);
  } finally {
    abort.mockRestore();
    failures.clear();
  }
});
