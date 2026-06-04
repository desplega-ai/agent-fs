import { describe, expect, test } from "bun:test";
import { AgentFsFileSystem, normalizePath } from "../index.js";

interface StoredFile {
  bytes: Uint8Array;
  modifiedAt: Date;
  version: number;
}

function createMockFetch() {
  const files = new Map<string, StoredFile>();

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";

    const rawMatch = url.pathname.match(
      /^\/orgs\/([^/]+)\/drives\/([^/]+)\/files\/(.+)\/raw$/,
    );
    if (rawMatch) {
      const path = normalizePath(decodeURIComponent(rawMatch[3]));
      if (method === "GET") {
        const file = files.get(path);
        if (!file) {
          return json({ error: "NOT_FOUND", message: `File not found: ${path}` }, 404);
        }
        return new Response(file.bytes.slice(), {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Agent-FS-Version": String(file.version),
            "Last-Modified": file.modifiedAt.toUTCString(),
          },
        });
      }

      if (method === "PUT") {
        const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
        const previous = files.get(path);
        const version = (previous?.version ?? 0) + 1;
        files.set(path, { bytes, version, modifiedAt: new Date() });
        return json({ version, path, size: bytes.length });
      }
    }

    if (url.pathname === "/orgs/org/ops" && method === "POST") {
      const body = await new Response(init?.body).json();
      const op = body.op as string;
      const path = body.path ? normalizePath(body.path) : undefined;

      if (op === "ls") {
        return json({ entries: listEntries(files, path ?? "/") });
      }

      if (op === "stat") {
        const file = files.get(path ?? "/");
        if (!file) {
          return json({ error: "NOT_FOUND", message: `File not found: ${path}` }, 404);
        }
        return json({
          path,
          size: file.bytes.length,
          modifiedAt: file.modifiedAt.toISOString(),
          createdAt: file.modifiedAt.toISOString(),
        });
      }

      if (op === "rm") {
        files.delete(path ?? "/");
        return json({ path, deleted: true });
      }

      if (op === "cp") {
        const from = normalizePath(body.from);
        const to = normalizePath(body.to);
        const source = files.get(from);
        if (!source) {
          return json({ error: "NOT_FOUND", message: `File not found: ${from}` }, 404);
        }
        files.set(to, {
          bytes: source.bytes.slice(),
          modifiedAt: new Date(),
          version: 1,
        });
        return json({ from, to, version: 1 });
      }

      if (op === "mv") {
        const from = normalizePath(body.from);
        const to = normalizePath(body.to);
        const source = files.get(from);
        if (!source) {
          return json({ error: "NOT_FOUND", message: `File not found: ${from}` }, 404);
        }
        files.delete(from);
        files.set(to, {
          bytes: source.bytes,
          modifiedAt: new Date(),
          version: source.version + 1,
        });
        return json({ from, to, version: source.version + 1 });
      }
    }

    return json({ error: "NOT_FOUND", message: "not found" }, 404);
  };

  return { fetch, files };
}

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

function listEntries(files: Map<string, StoredFile>, dir: string) {
  const normalized = normalizePath(dir);
  const prefix = normalized === "/" ? "/" : `${normalized}/`;
  const entries = new Map<string, { name: string; type: "file" | "directory"; size: number }>();

  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    if (!remainder) continue;
    const slash = remainder.indexOf("/");
    if (slash >= 0) {
      const name = remainder.slice(0, slash);
      entries.set(name, { name, type: "directory", size: 0 });
    } else {
      entries.set(remainder, { name: remainder, type: "file", size: file.bytes.length });
    }
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
