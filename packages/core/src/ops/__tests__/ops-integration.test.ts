import { describe, test, expect } from "bun:test";
import { dispatchOp } from "../index.js";
import { createTestContext } from "../../test-utils.js";

describe("write + cat operations", () => {
  test("write creates file and cat reads it back", async () => {
    const { ctx } = createTestContext();

    const writeResult = await dispatchOp(ctx, "write", {
      path: "/hello.txt",
      content: "Hello World",
      message: "initial commit",
    });

    expect((writeResult as any).version).toBe(1);
    expect((writeResult as any).path).toBe("/hello.txt");

    const catResult = await dispatchOp(ctx, "cat", { path: "/hello.txt" });
    expect((catResult as any).content).toBe("Hello World");
  });

  test("write with expectedVersion succeeds on match", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/ver.txt", content: "v1" });

    const result = await dispatchOp(ctx, "write", {
      path: "/ver.txt",
      content: "v2",
      expectedVersion: 1,
    });
    expect((result as any).version).toBe(2);
  });

  test("write with wrong expectedVersion throws", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/ver.txt", content: "v1" });

    await expect(
      dispatchOp(ctx, "write", {
        path: "/ver.txt",
        content: "v2",
        expectedVersion: 99,
      })
    ).rejects.toThrow();
  });

  test("cat non-existent file throws", async () => {
    const { ctx } = createTestContext();

    await expect(
      dispatchOp(ctx, "cat", { path: "/missing.txt" })
    ).rejects.toThrow();
  });
});

describe("edit operation", () => {
  test("edit replaces string in file", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/e.txt", content: "Hello World" });

    const result = await dispatchOp(ctx, "edit", {
      path: "/e.txt",
      old_string: "World",
      new_string: "Universe",
    });
    expect((result as any).version).toBe(2);

    const cat = await dispatchOp(ctx, "cat", { path: "/e.txt" });
    expect((cat as any).content).toBe("Hello Universe");
  });

  test("edit throws when old_string not found", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/e2.txt", content: "Hello" });

    await expect(
      dispatchOp(ctx, "edit", {
        path: "/e2.txt",
        old_string: "NotInFile",
        new_string: "Replaced",
      })
    ).rejects.toThrow();
  });
});

describe("append operation", () => {
  test("append adds content to existing file", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/app.txt", content: "Line 1" });
    await dispatchOp(ctx, "append", { path: "/app.txt", content: "\nLine 2" });

    const cat = await dispatchOp(ctx, "cat", { path: "/app.txt" });
    expect((cat as any).content).toBe("Line 1\nLine 2");
  });
});

describe("rm operation", () => {
  test("rm soft-deletes file", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/del.txt", content: "bye" });
    const result = await dispatchOp(ctx, "rm", { path: "/del.txt" });
    expect((result as any).deleted).toBe(true);

    // Should not appear in ls
    const ls = await dispatchOp(ctx, "ls", { path: "/" });
    const names = ((ls as any).entries as any[]).map((e: any) => e.name);
    expect(names).not.toContain("del.txt");
  });
});

describe("mv and cp operations", () => {
  test("mv moves file from one path to another", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/src.txt", content: "data" });
    await dispatchOp(ctx, "mv", { from: "/src.txt", to: "/dest.txt" });

    const cat = await dispatchOp(ctx, "cat", { path: "/dest.txt" });
    expect((cat as any).content).toBe("data");

    // Original should be gone
    await expect(
      dispatchOp(ctx, "cat", { path: "/src.txt" })
    ).rejects.toThrow();
  });

  test("cp copies file", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/orig.txt", content: "copy me" });
    await dispatchOp(ctx, "cp", { from: "/orig.txt", to: "/copy.txt" });

    const origCat = await dispatchOp(ctx, "cat", { path: "/orig.txt" });
    const copyCat = await dispatchOp(ctx, "cat", { path: "/copy.txt" });
    expect((origCat as any).content).toBe("copy me");
    expect((copyCat as any).content).toBe("copy me");
  });
});

describe("ls and mkdir operations", () => {
  test("ls returns files in directory", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/docs/a.txt", content: "a" });
    await dispatchOp(ctx, "write", { path: "/docs/b.txt", content: "b" });

    const result = await dispatchOp(ctx, "ls", { path: "/docs" });
    const names = ((result as any).entries as any[]).map((e: any) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  test("mkdir creates directory marker", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "mkdir", { path: "/newdir" });

    const result = await dispatchOp(ctx, "ls", { path: "/" });
    const dirs = ((result as any).entries as any[]).filter(
      (e: any) => e.type === "directory"
    );
    expect(dirs.some((d: any) => d.name === "newdir")).toBe(true);
  });
});

describe("head and tail operations", () => {
  test("head returns first N lines", async () => {
    const { ctx } = createTestContext();
    const content = "line1\nline2\nline3\nline4\nline5";

    await dispatchOp(ctx, "write", { path: "/lines.txt", content });

    const result = await dispatchOp(ctx, "head", { path: "/lines.txt", lines: 2 });
    expect((result as any).content).toBe("line1\nline2");
  });

  test("tail returns last N lines", async () => {
    const { ctx } = createTestContext();
    const content = "line1\nline2\nline3\nline4\nline5";

    await dispatchOp(ctx, "write", { path: "/lines2.txt", content });

    const result = await dispatchOp(ctx, "tail", { path: "/lines2.txt", lines: 2 });
    expect((result as any).content).toBe("line4\nline5");
  });
});

describe("stat operation", () => {
  test("stat returns file metadata", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/meta.txt", content: "hello" });

    const result = await dispatchOp(ctx, "stat", { path: "/meta.txt" });
    expect((result as any).path).toBe("/meta.txt");
    expect((result as any).size).toBeGreaterThan(0);
    expect((result as any).author).toBe(ctx.userId);
    expect((result as any).isDeleted).toBe(false);
  });
});

describe("log operation", () => {
  test("log returns version history", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/hist.txt", content: "v1" });
    await dispatchOp(ctx, "edit", {
      path: "/hist.txt",
      old_string: "v1",
      new_string: "v2",
    });

    const result = await dispatchOp(ctx, "log", { path: "/hist.txt" });
    const versions = (result as any).versions;
    expect(versions.length).toBe(2);
    expect(versions[0].version).toBeDefined();
  });
});

describe("diff operation", () => {
  test("diff shows changes between versions", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/d.txt", content: "old" });
    await dispatchOp(ctx, "edit", {
      path: "/d.txt",
      old_string: "old",
      new_string: "new",
    });

    const result = await dispatchOp(ctx, "diff", {
      path: "/d.txt",
      v1: 1,
      v2: 2,
    });
    const changes = (result as any).changes;
    expect(changes.length).toBeGreaterThan(0);
  });
});

describe("revert operation", () => {
  test("revert restores content from earlier version", async () => {
    const { ctx } = createTestContext({ versioningEnabled: true });

    await dispatchOp(ctx, "write", { path: "/rev.txt", content: "original" });
    await dispatchOp(ctx, "edit", {
      path: "/rev.txt",
      old_string: "original",
      new_string: "changed",
    });

    await dispatchOp(ctx, "revert", { path: "/rev.txt", version: 1 });

    const cat = await dispatchOp(ctx, "cat", { path: "/rev.txt" });
    expect((cat as any).content).toBe("original");
  });
});

describe("recent operation", () => {
  test("recent returns recently modified files", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/r1.txt", content: "a" });
    await dispatchOp(ctx, "write", { path: "/r2.txt", content: "b" });

    const result = await dispatchOp(ctx, "recent", {});
    const entries = (result as any).entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });
});

describe("grep operation", () => {
  test("grep finds matching content", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", {
      path: "/searchme.txt",
      content: "The quick brown fox\njumps over the lazy dog",
    });

    const result = await dispatchOp(ctx, "grep", {
      pattern: "quick",
      path: "/",
    });
    expect((result as any).matches.length).toBeGreaterThan(0);
  });
});

describe("find operation", () => {
  test("find searches content via FTS5", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/docs/readme.md", content: "installation guide" });
    await dispatchOp(ctx, "write", { path: "/docs/api.md", content: "API reference" });
    await dispatchOp(ctx, "write", { path: "/src/app.ts", content: "main application" });

    const result = await dispatchOp(ctx, "find", { pattern: "installation" });
    const paths = (result as any).matches.map((m: any) => m.path);
    expect(paths.length).toBe(1);
    expect(paths[0]).toBe("/docs/readme.md");
  });

  test("find with path prefix filters results", async () => {
    const { ctx } = createTestContext();

    await dispatchOp(ctx, "write", { path: "/docs/a.txt", content: "shared keyword" });
    await dispatchOp(ctx, "write", { path: "/src/b.txt", content: "shared keyword" });

    const result = await dispatchOp(ctx, "find", {
      pattern: "shared",
      path: "/docs/",
    });
    expect((result as any).matches.length).toBe(1);
    expect((result as any).matches[0].path).toBe("/docs/a.txt");
  });

  test("find returns hint when no matches", async () => {
    const { ctx } = createTestContext();

    const result = await dispatchOp(ctx, "find", { pattern: "nonexistent" });
    expect((result as any).matches.length).toBe(0);
    expect((result as any).hint).toBeDefined();
  });
});

describe("dispatch integration", () => {
  test("dispatchOp with unknown op throws", async () => {
    const { ctx } = createTestContext();

    await expect(
      dispatchOp(ctx, "nonexistent", {})
    ).rejects.toThrow("Unknown operation: nonexistent");
  });

  test("dispatchOp enforces RBAC", async () => {
    const { ctx, db } = createTestContext();
    const { createUser } = await import("../../identity/users.js");
    const { inviteToOrg } = await import("../../identity/orgs.js");

    // Create a viewer user
    const viewer = createUser(db, { email: "viewer@example.com" });
    inviteToOrg(db, {
      orgId: ctx.orgId,
      email: "viewer@example.com",
      role: "viewer",
    });

    const viewerCtx = { ...ctx, userId: viewer.user.id };

    // Viewer should be able to read
    await dispatchOp(ctx, "write", { path: "/rbac.txt", content: "test" });
    await expect(
      dispatchOp(viewerCtx, "cat", { path: "/rbac.txt" })
    ).resolves.toBeDefined();

    // Viewer should NOT be able to write
    await expect(
      dispatchOp(viewerCtx, "write", { path: "/blocked.txt", content: "no" })
    ).rejects.toThrow();
  });
});
