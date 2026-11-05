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
import {
  createUser,
  listUserOrgs,
  listDrives,
  setDriveMember,
  resetApiKeyOrgless,
  getConfig,
  setConfigValue,
  createUserApiKey,
} from "../../../../core/src/index.js";
import { startIpcServer } from "../server.js";

const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false });

interface TestHarness {
  socketPath: string;
  apiKey: string;
  userId: string;
  driveId: string;
  driveSlug: string;
  db: ReturnType<typeof createTestDb>;
  /** Swap the API key the daemon resolves — lets tests act as other users. */
  setApiKey: (key: string) => void;
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

  let currentApiKey = apiKey;
  const server = startIpcServer(socketPath, {
    db,
    s3: s3 as any,
    embeddingProvider: null,
    resolveApiKey: () => currentApiKey,
  });

  return {
    socketPath,
    apiKey,
    userId: user.id,
    driveId: drives[0].id,
    driveSlug: drives[0].name,
    db,
    setApiKey: (key: string) => {
      currentApiKey = key;
    },
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

  test("OpenWrite then OpenRead preserve binary bytes", async () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe,
    ]);
    const wresp: any = await roundTrip(harness.socketPath, {
      op: "open_write",
      drive: harness.driveSlug,
      path: "/ipc-binary.png",
      base_version: null,
      content_hash: "",
      bytes,
    });
    expect(wresp.open_write).toBeDefined();

    const rresp: any = await roundTrip(harness.socketPath, {
      op: "open_read",
      drive: harness.driveSlug,
      path: "/ipc-binary.png",
    });
    expect(rresp.open_read).toBeDefined();
    expect(Array.from(new Uint8Array(rresp.open_read.bytes))).toEqual(Array.from(bytes));
    expect(rresp.open_read.size).toBe(bytes.byteLength);
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

  test("each IPC write handler enqueues one file.changed per version; a deduped write enqueues none", async () => {
    const raw = harness.db.$client;
    const orgId = (raw.prepare("SELECT org_id FROM drives WHERE id = ?").get(harness.driveId) as { org_id: string }).org_id;
    const now = Date.now();
    raw
      .prepare(
        "INSERT INTO webhook_subscriptions (id, org_id, drive_id, url, event_types, secret_ciphertext, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run("ipc-hook", orgId, harness.driveId, "https://hooks.example.com/ipc", '["file.changed"]', "ct", harness.userId, now, now);
    const send = async (body: Record<string, unknown>) => {
      const resp: any = await roundTrip(harness.socketPath, { drive: harness.driveSlug, ...body });
      expect(resp?.error).toBeUndefined();
      return resp;
    };
    const bytes = new TextEncoder().encode("hello ipc\n");

    await send({ op: "create_file", path: "/ipc.md" });
    await send({ op: "open_write", path: "/ipc.md", base_version: 1, content_hash: "", bytes });
    const dedup = await send({ op: "open_write", path: "/ipc.md", base_version: 2, content_hash: "", bytes });
    expect(dedup.open_write.deduped).toBe(true);
    await send({ op: "truncate", path: "/ipc.md", size: 5 });
    await send({ op: "rename", from_path: "/ipc.md", to_path: "/ipc-moved.md" });
    await send({ op: "unlink", path: "/ipc-moved.md" });

    const got = (
      raw.prepare("SELECT event_type, payload FROM webhook_deliveries ORDER BY rowid").all() as Array<{
        event_type: string;
        payload: string;
      }>
    ).map((r) => {
      const { data } = JSON.parse(r.payload);
      return [r.event_type, data.path, data.version, data.operation, data.size];
    });
    expect(got).toEqual([
      ["file.changed", "/ipc.md", 1, "write", 0],
      ["file.changed", "/ipc.md", 2, "write", bytes.length],
      ["file.changed", "/ipc.md", 3, "write", 5],
      ["file.changed", "/ipc-moved.md", 1, "write", 5],
      ["file.changed", "/ipc.md", 4, "delete", null],
      ["file.changed", "/ipc-moved.md", 2, "delete", null],
    ]);
  });

  test("unknown op returns a structured validation error", async () => {
    const resp: any = await roundTrip(harness.socketPath, { op: "nope" });
    expect(resp.error).toBeDefined();
    expect(resp.error.http_status).toBe(400);
  });

  test("viewer cannot open_write but editor can", async () => {
    // Add a viewer and an editor as explicit members of the owner's drive.
    // The drive is referenced by id (not slug) so the lookup can't collide
    // with the secondary users' own personal default drives.
    const viewer = createUser(harness.db, { email: "ipc-viewer@example.com" });
    setDriveMember(harness.db, {
      driveId: harness.driveId,
      userId: viewer.user.id,
      role: "viewer",
    });
    const editor = createUser(harness.db, { email: "ipc-editor@example.com" });
    setDriveMember(harness.db, {
      driveId: harness.driveId,
      userId: editor.user.id,
      role: "editor",
    });

    // Seed a file as the owner (drive admin).
    const seed: any = await roundTrip(harness.socketPath, {
      op: "open_write",
      drive: harness.driveId,
      path: "/rbac.md",
      base_version: null,
      content_hash: "",
      bytes: new TextEncoder().encode("seeded by admin"),
    });
    expect(seed.open_write).toBeDefined();
    expect(seed.open_write.version).toBe(1);

    // Viewer: reads succeed, every write-shaped op is denied with 403.
    harness.setApiKey(viewer.apiKey);

    const read: any = await roundTrip(harness.socketPath, {
      op: "open_read",
      drive: harness.driveId,
      path: "/rbac.md",
    });
    expect(read.open_read).toBeDefined();
    expect(new TextDecoder().decode(new Uint8Array(read.open_read.bytes))).toBe(
      "seeded by admin"
    );

    const write: any = await roundTrip(harness.socketPath, {
      op: "open_write",
      drive: harness.driveId,
      path: "/rbac.md",
      base_version: null,
      content_hash: "",
      bytes: new TextEncoder().encode("viewer write"),
    });
    expect(write.error).toBeDefined();
    expect(write.error.http_status).toBe(403);
    expect(write.error.code).toBe("PERMISSION_DENIED");

    const create: any = await roundTrip(harness.socketPath, {
      op: "create_file",
      drive: harness.driveId,
      path: "/rbac-new.md",
    });
    expect(create.error).toBeDefined();
    expect(create.error.http_status).toBe(403);

    const truncate: any = await roundTrip(harness.socketPath, {
      op: "truncate",
      drive: harness.driveId,
      path: "/rbac.md",
      size: 0,
    });
    expect(truncate.error).toBeDefined();
    expect(truncate.error.http_status).toBe(403);

    // Editor: open_write succeeds and bumps the version.
    harness.setApiKey(editor.apiKey);
    const editorWrite: any = await roundTrip(harness.socketPath, {
      op: "open_write",
      drive: harness.driveId,
      path: "/rbac.md",
      base_version: 1,
      content_hash: "",
      bytes: new TextEncoder().encode("editor write"),
    });
    expect(editorWrite.open_write).toBeDefined();
    expect(editorWrite.open_write.version).toBe(2);
  });
});

describe("IPC server — daemon credential after a self-reset (no restart)", () => {
  // packages/server/src/index.ts:16 reads `const config = getConfig()` once
  // at process startup. Before the fix, the IPC resolveApiKey closure
  // returned that frozen snapshot forever, so a self-reset (which rewrites
  // config.json but not that snapshot) locked out every FUSE mount until the
  // daemon was restarted. The fix rereads getConfig() on every call, since
  // getConfig() itself does a fresh disk read with no cache (packages/core/
  // src/config.ts). This test runs both the frozen and the fresh resolver
  // against ONE running daemon to prove the fix needs no restart.
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "agent-fs-home-test-"));
    prevHome = process.env.AGENT_FS_HOME;
    process.env.AGENT_FS_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENT_FS_HOME;
    else process.env.AGENT_FS_HOME = prevHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("frozen-at-startup resolver 401s after reset; getConfig()-per-call resolver keeps working", async () => {
    const db = createTestDb();
    const s3 = new MockS3Client();
    const { user, apiKey } = createUser(db, { email: "reset-ipc@example.com" });
    setConfigValue("auth.apiKey", apiKey);

    // Mirrors the buggy packages/server/src/index.ts:16 — read once, before
    // the daemon has ever seen a reset.
    const configAtStartup = getConfig();
    let useFrozenSnapshot = false;

    const socketPath = join(tmpHome, "ipc.sock");
    const server = startIpcServer(socketPath, {
      db,
      s3: s3 as any,
      embeddingProvider: null,
      resolveApiKey: () =>
        (useFrozenSnapshot ? configAtStartup : getConfig()).auth?.apiKey ?? null,
    });

    try {
      // Sanity check: both patterns authenticate before any reset happens.
      const before: any = await roundTrip(socketPath, { op: "list_drives" });
      expect(before.drives).toBeInstanceOf(Array);

      // Simulate `agent-fs auth reset-key`: rotate the DB-side key hash (the
      // server-side half of /auth/reset-key) and persist the new key to
      // config.json (the CLI-side half in auth.ts) — no daemon restart.
      const { apiKey: newApiKey } = resetApiKeyOrgless(db, user.id);
      setConfigValue("auth.apiKey", newApiKey);

      // Pre-fix behavior: the resolver frozen at startup keeps offering the
      // now-revoked key, so the FUSE-mount auth path fails without a restart.
      useFrozenSnapshot = true;
      const stale: any = await roundTrip(socketPath, { op: "list_drives" });
      expect(stale.error).toBeDefined();
      expect(stale.error.http_status).toBe(401);
      expect(stale.error.code).toBe("AUTH_MISSING");

      // Fixed behavior: rereading getConfig() picks up the rotated key on
      // the very next call, on the same running daemon.
      useFrozenSnapshot = false;
      const fresh: any = await roundTrip(socketPath, { op: "list_drives" });
      expect(fresh.drives).toBeInstanceOf(Array);
      expect(fresh.drives[0].slug).toBe(listDrives(db, listUserOrgs(db, user.id)[0].id)[0].name);
    } finally {
      server.stop();
    }
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

describe("IPC refuses org-scoped keys", () => {
  test("an admin-minted, org-scoped key is refused; the user's own extra key works", async () => {
    const h = setup();
    try {
      const orgId = listUserOrgs(h.db, h.userId)[0].id;
      const scoped = createUserApiKey(h.db, { userId: h.userId, label: "s", actorId: h.userId, scopeOrgId: orgId });
      const own = createUserApiKey(h.db, { userId: h.userId, label: "o", actorId: h.userId });

      h.setApiKey(scoped.apiKey);
      const refused: any = await roundTrip(h.socketPath, { op: "list_drives" });
      expect(refused.error).toBeDefined();
      expect(refused.error.http_status).toBe(401);

      h.setApiKey(own.apiKey);
      const ok: any = await roundTrip(h.socketPath, { op: "list_drives" });
      expect(ok.drives).toBeInstanceOf(Array);
    } finally {
      h.stop();
    }
  });
});
