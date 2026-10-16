import { describe, expect, test } from "bun:test";
import { AgentFsFileSystem } from "../index.js";
import { createMockFetch } from "./mock-agent-fs.js";

describe("AgentFsFileSystem", () => {
  test("reads, writes, appends, stats, lists, and removes files", async () => {
    const { fetch } = createMockFetch();
    const fs = new AgentFsFileSystem({
      baseUrl: "http://agent.test",
      apiKey: "key",
      orgId: "org",
      driveId: "drive",
      fetch,
    });

    await fs.mkdir("/work", { recursive: true });
    await fs.writeFile("/work/hello.txt", "hello");
    await fs.appendFile("/work/hello.txt", " world");
    await fs.writeFile("/work/a #b.txt", "special");

    expect(await fs.readFile("/work/hello.txt")).toBe("hello world");
    expect(await fs.readFile("/work/a #b.txt")).toBe("special");
    expect(await fs.exists("/work/hello.txt")).toBe(true);
    expect(await fs.exists("/missing.txt")).toBe(false);
    expect((await fs.stat("/work")).isDirectory).toBe(true);
    expect((await fs.stat("/work/hello.txt")).isFile).toBe(true);
    expect(await fs.readdir("/work")).toEqual(["a #b.txt", "hello.txt"]);

    await fs.rm("/work/hello.txt");
    expect(await fs.exists("/work/hello.txt")).toBe(false);
  });

  test("preserves binary content and exposes just-bash byte strings", async () => {
    const { fetch } = createMockFetch();
    const fs = new AgentFsFileSystem({
      baseUrl: "http://agent.test",
      orgId: "org",
      driveId: "drive",
      fetch,
    });

    await fs.writeFile("/bytes.bin", new Uint8Array([0, 255, 65]));

    expect([...await fs.readFileBuffer("/bytes.bin")]).toEqual([0, 255, 65]);
    expect([...await fs.readFileBytes!("/bytes.bin")].map((char) => char.charCodeAt(0))).toEqual([
      0,
      255,
      65,
    ]);
    expect(await fs.readFile("/bytes.bin", "hex")).toBe("00ff41");
    expect(await fs.readFile("/bytes.bin", "base64")).toBe("AP9B");
  });

  test("percent-encodes a non-ASCII write message and flags the encoding", async () => {
    // Raw fetch Headers reject non-Latin-1 values outright (e.g. an em
    // dash), so putRaw must percent-encode X-Agent-FS-Message and flag it
    // with X-Agent-FS-Message-Encoding so the server knows to decode it.
    const { fetch: mockFetch } = createMockFetch();
    const seenHeaders: Headers[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        seenHeaders.push(new Headers(init?.headers));
      }
      return mockFetch(input, init);
    };

    const fs = new AgentFsFileSystem({
      baseUrl: "http://agent.test",
      orgId: "org",
      driveId: "drive",
      writeMessage: "v2 — fix (café)",
      fetch,
    });

    await fs.writeFile("/message.txt", "content");

    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0].get("X-Agent-FS-Message-Encoding")).toBe("percent");
    expect(seenHeaders[0].get("X-Agent-FS-Message")).toBe(
      encodeURIComponent("v2 — fix (café)"),
    );
  });

  test("copies, moves, and recursively removes synthetic directories", async () => {
    const { fetch } = createMockFetch();
    const fs = new AgentFsFileSystem({
      baseUrl: "http://agent.test",
      orgId: "org",
      driveId: "drive",
      fetch,
    });

    await fs.writeFile("/src/a.txt", "a");
    await fs.writeFile("/src/nested/b.txt", "b");
    await fs.cp("/src", "/copy", { recursive: true });

    expect(await fs.readFile("/copy/a.txt")).toBe("a");
    expect(await fs.readFile("/copy/nested/b.txt")).toBe("b");

    await fs.mv("/copy/a.txt", "/copy/c.txt");
    expect(await fs.readFile("/copy/c.txt")).toBe("a");
    expect(await fs.exists("/copy/a.txt")).toBe(false);

    await fs.rm("/copy", { recursive: true });
    expect(await fs.exists("/copy/c.txt")).toBe(false);
  });

  test("normalizes paths and rejects unsupported symlinks", async () => {
    const { fetch } = createMockFetch();
    const fs = new AgentFsFileSystem({
      baseUrl: "http://agent.test",
      orgId: "org",
      driveId: "drive",
      fetch,
    });

    expect(fs.resolvePath("/a/b", "../c")).toBe("/a/c");
    await expect(fs.symlink("/target", "/link")).rejects.toThrow("EPERM");
    await expect(fs.readFile("/bad\0path")).rejects.toThrow("null byte");
  });
});

describe("AgentFsFileSystem stat/ls cache", () => {
  function drive(
    mock: ReturnType<typeof createMockFetch>,
    options: { cacheTtlMs?: number } = {},
  ) {
    return new AgentFsFileSystem({
      baseUrl: "http://agent.test",
      orgId: "org",
      driveId: "drive",
      fetch: mock.fetch,
      ...options,
    });
  }

  test("answers repeat stat, exists, and readdir calls from the cache", async () => {
    const mock = createMockFetch();
    const fs = drive(mock);
    await fs.writeFile("/work/a.txt", "a");
    mock.requests.length = 0;

    await fs.stat("/work/a.txt");
    await fs.stat("/work/a.txt");
    await fs.exists("/work/a.txt");
    expect(await fs.readdir("/work")).toEqual(["a.txt"]);
    expect(await fs.readdir("/work")).toEqual(["a.txt"]);
    expect((await fs.stat("/work")).isDirectory).toBe(true);

    // "/work is not a file" is still cached from the write's parent check.
    expect(mock.requests).toEqual(["stat /work/a.txt", "ls /work"]);
  });

  test("answers stat for a listed file and a missing name from the listing", async () => {
    const mock = createMockFetch();
    const fs = drive(mock);
    await fs.writeFile("/work/a.txt", "abc");
    await fs.readdir("/work");
    mock.requests.length = 0;

    expect((await fs.stat("/work/a.txt")).size).toBe(3);
    expect(await fs.exists("/work/missing.txt")).toBe(false);
    await expect(fs.readdir("/work/missing")).rejects.toThrow("ENOENT");

    expect(mock.requests).toEqual([]);
  });

  test("sees its own writes at once", async () => {
    const mock = createMockFetch();
    const fs = drive(mock);
    await fs.writeFile("/work/a.txt", "a");
    expect((await fs.stat("/work/a.txt")).size).toBe(1);
    expect(await fs.readdir("/work")).toEqual(["a.txt"]);

    await fs.appendFile("/work/a.txt", "bc");
    await fs.writeFile("/work/b.txt", "b");
    await fs.mkdir("/work/sub");
    expect((await fs.stat("/work/a.txt")).size).toBe(3);
    expect(await fs.readdir("/work")).toEqual(["a.txt", "b.txt", "sub"]);
    expect((await fs.stat("/work/sub")).isDirectory).toBe(true);

    await fs.mv("/work/b.txt", "/work/sub/b.txt");
    expect(await fs.readdir("/work")).toEqual(["a.txt", "sub"]);
    expect(await fs.readdir("/work/sub")).toEqual(["b.txt"]);

    await fs.cp("/work/a.txt", "/work/c.txt");
    expect(await fs.exists("/work/c.txt")).toBe(true);

    await fs.rm("/work/a.txt");
    expect(await fs.exists("/work/a.txt")).toBe(false);
    await fs.rm("/work", { recursive: true });
    expect(await fs.exists("/work")).toBe(false);
    expect(await fs.exists("/work/sub/b.txt")).toBe(false);
  });

  test("hides another client's change until the entry expires", async () => {
    const mock = createMockFetch();
    const writer = drive(mock);
    await writer.writeFile("/shared/a.txt", "a");

    const cached = drive(mock);
    expect(await cached.readdir("/shared")).toEqual(["a.txt"]);
    await writer.writeFile("/shared/b.txt", "b");
    expect(await cached.readdir("/shared")).toEqual(["a.txt"]);

    const shortLived = drive(mock, { cacheTtlMs: 1 });
    await shortLived.readdir("/shared");
    await writer.writeFile("/shared/c.txt", "c");
    await Bun.sleep(5);
    expect(await shortLived.readdir("/shared")).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("refreshAllPaths lists again past the cache", async () => {
    const mock = createMockFetch();
    const writer = drive(mock);
    await writer.writeFile("/shared/a.txt", "a");

    const fs = drive(mock);
    await fs.readdir("/shared");
    await writer.writeFile("/shared/b.txt", "b");

    expect(await fs.refreshAllPaths("/shared")).toContain("/shared/b.txt");
    expect(await fs.readdir("/shared")).toEqual(["a.txt", "b.txt"]);
  });

  test("cacheTtlMs 0 sends every call", async () => {
    const mock = createMockFetch();
    const fs = drive(mock, { cacheTtlMs: 0 });
    await fs.writeFile("/a.txt", "a");
    mock.requests.length = 0;

    await fs.stat("/a.txt");
    await fs.stat("/a.txt");

    expect(mock.requests).toEqual(["stat /a.txt", "stat /a.txt"]);
  });

  test("shares one request between concurrent callers", async () => {
    const mock = createMockFetch();
    const fs = drive(mock);
    await fs.writeFile("/a.txt", "a");
    mock.requests.length = 0;

    await Promise.all([fs.stat("/a.txt"), fs.stat("/a.txt"), fs.exists("/a.txt")]);

    expect(mock.requests).toEqual(["stat /a.txt"]);
  });

  test("does not cache a failed request", async () => {
    const mock = createMockFetch();
    let failNext = false;
    const fs = new AgentFsFileSystem({
      baseUrl: "http://agent.test",
      orgId: "org",
      driveId: "drive",
      fetch: async (input, init) => {
        if (failNext) {
          failNext = false;
          return new Response(JSON.stringify({ error: "INTERNAL", message: "boom" }), {
            status: 500,
          });
        }
        return mock.fetch(input, init);
      },
    });
    await fs.writeFile("/a.txt", "a");

    failNext = true;
    await expect(fs.stat("/a.txt")).rejects.toThrow("boom");
    expect((await fs.stat("/a.txt")).size).toBe(1);
  });
});
