import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../../../server/src/app.js";

// CLI surfacing test: drive the real ApiClient against an in-process daemon
// backed by a no-versioning adapter so a `revert` returns HTTP 422
// UNSUPPORTED_OPERATION. Assert the thrown Error.message is the clean
// message + "Suggestion:" line that `commands/ops.ts` prints as `Error: <msg>`
// — no stack trace, no raw S3/FS error.

let server: ReturnType<typeof Bun.serve>;
let port = 0;
let apiKey: string;
let orgId: string;

beforeAll(async () => {
  const db = createTestDb();
  const s3 = new MockS3Client({ capabilities: { versioning: false } });
  const app = createApp(db, s3 as any);

  server = Bun.serve({ port: 0, fetch: app.fetch });
  port = server.port!;

  const res = await fetch(`http://localhost:${port}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "cli-cap@example.com" }),
  });
  const body = await res.json();
  apiKey = body.apiKey;
  orgId = body.orgId;

  process.env.AGENT_FS_API_URL = `http://localhost:${port}`;
  process.env.AGENT_FS_API_KEY = apiKey;
});

afterAll(() => {
  server?.stop();
  delete process.env.AGENT_FS_API_URL;
  delete process.env.AGENT_FS_API_KEY;
});

describe("CLI surfacing of UnsupportedOperation", () => {
  async function makeClient() {
    const { ApiClient } = await import("../api-client.js");
    return new ApiClient();
  }

  test("revert 422 surfaces as a clean Error message with a Suggestion line", async () => {
    const client = await makeClient();

    // Seed a file so the version row exists.
    await client.callOp(orgId, "write", { path: "/cli-cap.txt", content: "v1" });

    let caught: Error | null = null;
    try {
      await client.callOp(orgId, "revert", { path: "/cli-cap.txt", version: 1 });
    } catch (err: any) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    const msg = caught!.message;
    // Clean, friendly wording + actionable suggestion...
    expect(msg).toContain("not supported");
    expect(msg).toContain("Suggestion:");
    // ...and NOT a stack trace leaking into the rendered line.
    expect(msg).not.toMatch(/\n\s+at\s/);
  });
});
