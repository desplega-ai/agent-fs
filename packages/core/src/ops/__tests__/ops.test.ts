import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, schema } from "../../db/index.js";
import { AgentS3Client } from "../../s3/client.js";
import type { OpContext } from "../types.js";
import { write } from "../write.js";
import { cat } from "../cat.js";
import { edit } from "../edit.js";
import { append } from "../append.js";
import { ls } from "../ls.js";
import { stat } from "../stat.js";
import { rm } from "../rm.js";
import { mv } from "../mv.js";
import { cp } from "../cp.js";
import { head } from "../head.js";
import { tail } from "../tail.js";
import { mkdir } from "../mkdir.js";
import { log } from "../log.js";
import { diff } from "../diff.js";
import { revert } from "../revert.js";
import { recent } from "../recent.js";
import { dispatchOp, getRegisteredOps } from "../index.js";
import { EditConflictError, NotFoundError } from "../../errors.js";

const TEST_DB = join(tmpdir(), `agentfs-ops-test-${Date.now()}.db`);
const ORG_ID = "test-org";
const DRIVE_ID = "test-drive";
const USER_ID = "test-user";

let ctx: OpContext;
let s3: AgentS3Client;

beforeAll(async () => {
  const db = createDatabase(TEST_DB);
  s3 = new AgentS3Client({
    provider: "minio",
    bucket: "agentfs",
    region: "us-east-1",
    endpoint: "http://localhost:9000",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  });

  // Enable versioning for tests
  await s3.enableVersioning();

  // Seed required FK data: user, org, drive
  const now = new Date();
  db.insert(schema.users).values({ id: USER_ID, email: "test@example.com", apiKeyHash: "test", createdAt: now }).run();
  db.insert(schema.orgs).values({ id: ORG_ID, name: "Test Org", createdAt: now }).run();
  db.insert(schema.drives).values({ id: DRIVE_ID, orgId: ORG_ID, name: "default", isDefault: true, createdAt: now }).run();

  ctx = { db, s3, orgId: ORG_ID, driveId: DRIVE_ID, userId: USER_ID };
});

afterAll(() => {
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

describe("write + cat roundtrip", () => {
  test("write creates file and cat reads it back", async () => {
    const result = await write(ctx, {
      path: "/docs/readme.md",
      content: "# Hello World\n\nThis is a test.",
      message: "Initial write",
    });

    expect(result.version).toBe(1);
    expect(result.path).toBe("/docs/readme.md");
    expect(result.size).toBeGreaterThan(0);

    const catResult = await cat(ctx, { path: "/docs/readme.md" });
    expect(catResult.content).toBe("# Hello World\n\nThis is a test.");
    expect(catResult.totalLines).toBe(3);
    expect(catResult.truncated).toBe(false);
  });

  test("cat with offset and limit", async () => {
    await write(ctx, {
      path: "/docs/lines.txt",
      content: Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n"),
    });

    const result = await cat(ctx, {
      path: "/docs/lines.txt",
      offset: 10,
      limit: 5,
    });

    expect(result.content).toBe("Line 11\nLine 12\nLine 13\nLine 14\nLine 15");
    expect(result.totalLines).toBe(50);
    expect(result.truncated).toBe(true);
  });

  test("cat throws NotFoundError for missing file", async () => {
    expect(cat(ctx, { path: "/nonexistent.txt" })).rejects.toThrow(NotFoundError);
  });
});

describe("edit", () => {
  test("edit replaces exact match and creates version", async () => {
    await write(ctx, {
      path: "/docs/editable.md",
      content: "Hello test project, welcome.",
    });

    const result = await edit(ctx, {
      path: "/docs/editable.md",
      old_string: "test project",
      new_string: "production project",
      message: "Updated description",
    });

    expect(result.version).toBe(2);
    expect(result.changes).toBe(1);

    const catResult = await cat(ctx, { path: "/docs/editable.md" });
    expect(catResult.content).toBe("Hello production project, welcome.");
  });

  test("edit throws EditConflictError when old_string not found", async () => {
    expect(
      edit(ctx, {
        path: "/docs/editable.md",
        old_string: "nonexistent text",
        new_string: "replacement",
      })
    ).rejects.toThrow(EditConflictError);
  });

  test("edit throws EditConflictError when old_string matches multiple times", async () => {
    await write(ctx, {
      path: "/docs/dupes.md",
      content: "foo bar foo baz foo",
    });

    expect(
      edit(ctx, {
        path: "/docs/dupes.md",
        old_string: "foo",
        new_string: "qux",
      })
    ).rejects.toThrow(EditConflictError);
  });
});

describe("append", () => {
  test("append adds content to file", async () => {
    await write(ctx, { path: "/docs/append.md", content: "Line 1" });
    const result = await append(ctx, {
      path: "/docs/append.md",
      content: "\nLine 2",
    });

    expect(result.version).toBe(2);

    const catResult = await cat(ctx, { path: "/docs/append.md" });
    expect(catResult.content).toBe("Line 1\nLine 2");
  });
});

describe("head + tail", () => {
  test("head returns first N lines", async () => {
    await write(ctx, {
      path: "/docs/headtail.txt",
      content: Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n"),
    });

    const result = await head(ctx, { path: "/docs/headtail.txt", lines: 5 });
    expect(result.content).toBe("L1\nL2\nL3\nL4\nL5");
    expect(result.truncated).toBe(true);
  });

  test("tail returns last N lines", async () => {
    const result = await tail(ctx, { path: "/docs/headtail.txt", lines: 3 });
    expect(result.content).toBe("L28\nL29\nL30");
    expect(result.truncated).toBe(true);
  });
});

describe("ls", () => {
  test("ls lists files in directory", async () => {
    await write(ctx, { path: "/lsdir/a.txt", content: "a" });
    await write(ctx, { path: "/lsdir/b.txt", content: "b" });
    await mkdir(ctx, { path: "/lsdir/sub" });

    const result = await ls(ctx, { path: "/lsdir" });
    const names = result.entries.map((e) => e.name);

    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
    expect(names).toContain("sub");
  });
});

describe("stat", () => {
  test("stat returns file metadata", async () => {
    await write(ctx, { path: "/docs/stat.md", content: "stat me" });

    const result = await stat(ctx, { path: "/docs/stat.md" });
    expect(result.path).toBe("/docs/stat.md");
    expect(result.size).toBe(7);
    expect(result.author).toBe(USER_ID);
    expect(result.isDeleted).toBe(false);
  });
});

describe("rm", () => {
  test("rm soft-deletes file", async () => {
    await write(ctx, { path: "/docs/delete-me.txt", content: "bye" });
    const result = await rm(ctx, { path: "/docs/delete-me.txt" });

    expect(result.deleted).toBe(true);

    // Log should show delete operation
    const logResult = await log(ctx, { path: "/docs/delete-me.txt" });
    expect(logResult.versions[0].operation).toBe("delete");
  });
});

describe("mv", () => {
  test("mv moves file to new path", async () => {
    await write(ctx, { path: "/docs/moveme.txt", content: "move me" });
    const result = await mv(ctx, {
      from: "/docs/moveme.txt",
      to: "/archive/moveme.txt",
    });

    expect(result.version).toBeGreaterThan(0);
    expect(result.from).toBe("/docs/moveme.txt");
    expect(result.to).toBe("/archive/moveme.txt");

    // New location should have content
    const catResult = await cat(ctx, { path: "/archive/moveme.txt" });
    expect(catResult.content).toBe("move me");
  });
});

describe("cp", () => {
  test("cp copies file to new path", async () => {
    await write(ctx, { path: "/docs/copyable.txt", content: "copy me" });
    const result = await cp(ctx, {
      from: "/docs/copyable.txt",
      to: "/backup/copyable.txt",
    });

    expect(result.version).toBeGreaterThan(0);

    // Both locations should have content
    const original = await cat(ctx, { path: "/docs/copyable.txt" });
    const copy = await cat(ctx, { path: "/backup/copyable.txt" });
    expect(original.content).toBe("copy me");
    expect(copy.content).toBe("copy me");
  });
});

describe("log + diff + revert", () => {
  test("log returns version history in correct order", async () => {
    await write(ctx, { path: "/docs/versioned.md", content: "v1" });
    await edit(ctx, {
      path: "/docs/versioned.md",
      old_string: "v1",
      new_string: "v2",
    });
    await edit(ctx, {
      path: "/docs/versioned.md",
      old_string: "v2",
      new_string: "v3",
    });

    const result = await log(ctx, { path: "/docs/versioned.md" });
    expect(result.versions.length).toBe(3);
    // Newest first
    expect(result.versions[0].version).toBe(3);
    expect(result.versions[1].version).toBe(2);
    expect(result.versions[2].version).toBe(1);
    expect(result.versions[0].operation).toBe("edit");
    expect(result.versions[2].operation).toBe("write");
  });

  test("diff returns changes between versions", async () => {
    const result = await diff(ctx, {
      path: "/docs/versioned.md",
      v1: 1,
      v2: 2,
    });

    expect(result.changes.length).toBeGreaterThan(0);
    // Should have a remove (v1) and add (v2)
    const removes = result.changes.filter((c) => c.type === "remove");
    const adds = result.changes.filter((c) => c.type === "add");
    expect(removes.length).toBeGreaterThan(0);
    expect(adds.length).toBeGreaterThan(0);
  });

  test("revert restores old content", async () => {
    const result = await revert(ctx, {
      path: "/docs/versioned.md",
      version: 1,
    });

    expect(result.revertedTo).toBe(1);
    expect(result.version).toBe(4); // New version created

    const catResult = await cat(ctx, { path: "/docs/versioned.md" });
    expect(catResult.content).toBe("v1");
  });
});

describe("recent", () => {
  test("recent returns activity across drive", async () => {
    const result = await recent(ctx, { limit: 10 });
    expect(result.entries.length).toBeGreaterThan(0);
    // Should be newest first
    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
        result.entries[i].createdAt.getTime()
      );
    }
  });
});

describe("op registry", () => {
  test("all 16 ops are registered", () => {
    const ops = getRegisteredOps();
    expect(ops.length).toBe(16);
    expect(ops).toContain("write");
    expect(ops).toContain("cat");
    expect(ops).toContain("edit");
    expect(ops).toContain("ls");
    expect(ops).toContain("revert");
    expect(ops).toContain("recent");
  });

  test("dispatchOp validates and dispatches", async () => {
    const result = await dispatchOp(ctx, "cat", { path: "/docs/readme.md" });
    expect((result as any).content).toBeTruthy();
  });

  test("dispatchOp throws on invalid params", () => {
    expect(dispatchOp(ctx, "write", {})).rejects.toThrow();
  });

  test("dispatchOp throws on unknown op", () => {
    expect(
      dispatchOp(ctx, "nonexistent", { path: "/" })
    ).rejects.toThrow("Unknown operation");
  });
});
