import { normalizePath } from "../index.js";

export interface StoredFile {
  bytes: Uint8Array;
  modifiedAt: Date;
  version: number;
}

/**
 * An in-memory agent-fs: the `/ops` and `/raw` routes the adapter calls.
 * `requests` records one label per call (`stat /a`, `ls /a`, `GET /a`,
 * `PUT /a`, ...), so tests can count round trips.
 */
export function createMockFetch() {
  const files = new Map<string, StoredFile>();
  const requests: string[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";

    const rawMatch = url.pathname.match(
      /^\/orgs\/([^/]+)\/drives\/([^/]+)\/files\/(.+)\/raw$/,
    );
    if (rawMatch) {
      const path = normalizePath(decodeURIComponent(rawMatch[3]));
      requests.push(`${method} ${path}`);
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
      requests.push(path ? `${op} ${path}` : `${op} ${body.from} ${body.to}`);

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

  return { fetch, files, requests };
}

function listEntries(files: Map<string, StoredFile>, dir: string) {
  const normalized = normalizePath(dir);
  const prefix = normalized === "/" ? "/" : `${normalized}/`;
  const entries = new Map<
    string,
    { name: string; type: "file" | "directory"; size: number; modifiedAt?: string }
  >();

  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    if (!remainder) continue;
    const slash = remainder.indexOf("/");
    if (slash >= 0) {
      const name = remainder.slice(0, slash);
      entries.set(name, { name, type: "directory", size: 0 });
    } else {
      entries.set(remainder, {
        name: remainder,
        type: "file",
        size: file.bytes.length,
        modifiedAt: file.modifiedAt.toISOString(),
      });
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
