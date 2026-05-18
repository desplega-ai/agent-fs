// Round-trip IPC server tests.
//
// Spin up the unix-socket listener, connect a raw Bun unix client, push msgpack
// frames, and assert the responses match. Each test exercises one handler
// against a real DB + Mock S3, using the same `createTestDb` /
// `MockS3Client` machinery the rest of the server tests rely on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Packr, Unpackr } from "msgpackr";
import { createTestDb, MockS3Client } from "../../../../core/src/test-utils.js";
import { createUser, listUserOrgs, listDrives } from "../../../../core/src/index.js";
import { startIpcServer } from "../server.js";

const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false });

interface TestHarness {
  socketPath: string;
  apiKey: string;
  userId: string;
  driveId: string;
  driveSlug: string;
  stop: () => void;
}

function setup(): TestHarness {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-fs-ipc-test-"));
  const socketPath = join(tmpDir, "ipc.sock");

  const db = createTestDb();
  const s3 = new MockS3Client();
  const { user, apiKey } = createUser(db, { email: "ipc-test@example.com" });
  const orgs = listUserOrgs(db, user.id);
  const drives = listDrives(db, orgs[0].id);

  const server = startIpcServer(socketPath, {
    db,
    s3: s3 as any,
    embeddingProvider: null,
    resolveApiKey: () => apiKey,
  });

  return {
    socketPath,
    apiKey,
    userId: user.id,
    driveId: drives[0].id,
    driveSlug: drives[0].name,
    stop: () => {
      server.stop();
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Send a single envelope to the IPC server and read the reply.
 */
async function roundTrip(socketPath: string, body: unknown): Promise<unknown> {
  // Bun.connect is async; we send one frame and read one frame back.
  const buf = packr.pack({ id: 1, body });
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(buf.length, 0);
  const frame = Buffer.concat([lenBuf, buf as unknown as Buffer]);

  return new Promise<unknown>((resolve, reject) => {
    let recvBuf = Buffer.alloc(0);
    let timeout: ReturnType<typeof setTimeout>;
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(frame);
          timeout = setTimeout(() => {
            reject(new Error("ipc roundTrip timed out"));
            socket.end();
          }, 5000);
        },
        data(socket, chunk) {
          recvBuf = Buffer.concat([recvBuf, chunk]);
          if (recvBuf.length < 4) return;
          const len = recvBuf.readUInt32BE(0);
          if (recvBuf.length < 4 + len) return;
          const env = unpackr.unpack(recvBuf.subarray(4, 4 + len)) as {
            id: number;
            body: unknown;
          };
          clearTimeout(timeout);
          socket.end();
          resolve(env.body);
        },
        error(_socket, err) {
          clearTimeout(timeout);
          reject(err);
        },
      },
    }).catch(reject);
  });
}

describe("IPC server — round-trip", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = setup();
  });

  afterEach(() => {
    harness.stop();
  });

  test("Ping returns Pong", async () => {
    const resp = await roundTrip(harness.socketPath, { op: "ping" });
    expect(resp).toBe("pong");
  });

  test("Hello returns Ok", async () => {
    const resp = await roundTrip(harness.socketPath, {
      op: "hello",
      client_version: "0.0.0-test",
      pid: 1,
    });
    expect(resp).toBe("ok");
  });

  test("ListDrives returns the user's visible drives", async () => {
    const resp: any = await roundTrip(harness.socketPath, { op: "list_drives" });
    expect(resp).toBeDefined();
    expect(resp.drives).toBeInstanceOf(Array);
    // The freshly-created user has a personal org with one default drive.
    expect(resp.drives.length).toBeGreaterThanOrEqual(1);
    expect(resp.drives[0].slug).toBe(harness.driveSlug);
  });

  test("DefaultDriveSlug returns the user's default drive slug", async () => {
    const resp: any = await roundTrip(harness.socketPath, {
      op: "default_drive_slug",
    });
    expect(resp.default_drive_slug).toBe(harness.driveSlug);
  });

  test("OpenWrite then OpenRead round-trip the file content", async () => {
    const bytes = new TextEncoder().encode("hello ipc\n");
    const wresp: any = await roundTrip(harness.socketPath, {
      op: "open_write",
      drive: harness.driveSlug,
      path: "/ipc-write.md",
      base_version: null,
      content_hash: "",
      bytes,
    });
    expect(wresp.open_write).toBeDefined();
    expect(wresp.open_write.version).toBeGreaterThanOrEqual(1);
    expect(wresp.open_write.deduped).toBe(false);

    const rresp: any = await roundTrip(harness.socketPath, {
      op: "open_read",
      drive: harness.driveSlug,
      path: "/ipc-write.md",
    });
    expect(rresp.open_read).toBeDefined();
    const out = new TextDecoder().decode(new Uint8Array(rresp.open_read.bytes));
    expect(out).toBe("hello ipc\n");
    expect(rresp.open_read.version).toBeGreaterThanOrEqual(1);
  });

  test("GetAttr after a write returns size + version", async () => {
    const bytes = new TextEncoder().encode("attrs");
    await roundTrip(harness.socketPath, {
      op: "open_write",
      drive: harness.driveSlug,
      path: "/attrs.md",
      base_version: null,
      content_hash: "",
      bytes,
    });
    const resp: any = await roundTrip(harness.socketPath, {
      op: "get_attr",
      drive: harness.driveSlug,
      path: "/attrs.md",
    });
    expect(resp.attr).toBeDefined();
    expect(resp.attr.size).toBe(5);
    expect(resp.attr.version).toBeGreaterThanOrEqual(1);
  });

  test("OpenWrite with base_version: 0 against existing file → 409 EditConflict", async () => {
    const bytes = new TextEncoder().encode("first");
    await roundTrip(harness.socketPath, {
      op: "open_write",
      drive: harness.driveSlug,
      path: "/conflict.md",
      base_version: null,
      content_hash: "",
      bytes,
    });
    // Now try to write with `base_version: 0` (i.e. "must not exist").
    const resp: any = await roundTrip(harness.socketPath, {
      op: "open_write",
      drive: harness.driveSlug,
      path: "/conflict.md",
      base_version: 0,
      content_hash: "",
      bytes: new TextEncoder().encode("second"),
    });
    expect(resp.error).toBeDefined();
    expect(resp.error.http_status).toBe(409);
    expect(resp.error.code).toBe("EDIT_CONFLICT");
  });

  test("unknown op returns a structured validation error", async () => {
    const resp: any = await roundTrip(harness.socketPath, { op: "nope" });
    expect(resp.error).toBeDefined();
    expect(resp.error.http_status).toBe(400);
  });
});

describe("IPC server — encoding helpers", () => {
  test("encodeFrame + decodeFrame round-trip an envelope", async () => {
    const { encodeFrame, decodeFrame } = await import("../server.js");
    const env = { id: 42, body: { op: "ping" } };
    const buf = encodeFrame(env);
    const dec = decodeFrame(buf);
    expect(dec).not.toBeNull();
    expect(dec!.env.id).toBe(42);
    expect((dec!.env.body as any).op).toBe("ping");
    expect(dec!.rest.length).toBe(0);
  });
});

