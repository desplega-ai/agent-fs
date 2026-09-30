import { getConfig } from "@/core";

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const READ_ONLY_OPS = new Set([
  "cat", "ls", "stat", "reveal", "tail", "log", "diff", "recent",
  "grep", "fts", "search", "vec-search", "tree", "glob", "sql",
  "signed-url", "comment-list", "comment-get", "comment-notification-list",
  "drive-members",
]);

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor() {
    const config = getConfig();
    this.baseUrl =
      process.env.AGENT_FS_API_URL ??
      config.apiUrl ??
      `http://${config.server.host}:${config.server.port}`;
    this.apiKey =
      process.env.AGENT_FS_API_KEY ??
      config.apiKey ??
      config.auth.apiKey;
    this.timeoutMs = getTimeoutMs(process.env.AGENT_FS_HTTP_TIMEOUT_MS);
  }

  private async request(
    path: string,
    opts?: RequestInit,
    retryTimeout = (opts?.method ?? "GET").toUpperCase() === "GET"
  ): Promise<any> {
    const headers = new Headers(opts?.headers);
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }
    headers.set("Content-Type", "application/json");

    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, { ...opts, headers }, retryTimeout);

    let body: any;
    try {
      body = await res.json();
    } catch {
      const text = await res.text().catch(() => "");
      throw new Error(`Unexpected response from daemon (${res.status}): ${text || "empty"}`);
    }
    if (!res.ok) {
      const msg = body.message ?? body.error ?? "Request failed";
      const suggestion = body.suggestion ? `\n  Suggestion: ${body.suggestion}` : "";
      throw new Error(`${msg}${suggestion}`);
    }
    return body;
  }

  async get(path: string): Promise<any> {
    return this.request(path);
  }

  async post(path: string, body: any): Promise<any> {
    return this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async patch(path: string, body: any): Promise<any> {
    return this.request(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async del(path: string): Promise<any> {
    return this.request(path, { method: "DELETE" });
  }

  async callOp(orgId: string, op: string, params: Record<string, any>): Promise<any> {
    return this.request(
      `/orgs/${orgId}/ops`,
      { method: "POST", body: JSON.stringify({ op, ...params }) },
      READ_ONLY_OPS.has(op)
    );
  }

  async getMe(): Promise<{ userId: string; email: string; defaultOrgId: string | null; defaultDriveId: string | null }> {
    return this.get("/auth/me");
  }

  async getEvents(orgId: string, driveId: string, signal: AbortSignal): Promise<Response> {
    const headers = new Headers({ Accept: "text/event-stream" });
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/orgs/${orgId}/drives/${driveId}/events`, { headers, signal });
    } catch {
      throw new Error(
        `Cannot connect to agent-fs daemon at ${this.baseUrl}. Is it running? Start with: agent-fs daemon start`
      );
    }
    if (!res.ok) {
      let body: any;
      const text = await res.text().catch(() => "");
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(
          `Unexpected response from daemon (${res.status}): ${text || "empty"}`
        );
      }
      const message = body.message ?? body.error ?? `Request failed (${res.status})`;
      const suggestion = body.suggestion ? `\n  Suggestion: ${body.suggestion}` : "";
      throw new Error(`${message}${suggestion}`);
    }
    return res;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  /**
   * Binary upload to `PUT /orgs/:orgId/drives/:driveId/files/<path>/raw`.
   *
   * Bypasses the JSON op path so the body can exceed the 10 MB JSON cap (up
   * to the configured HTTP body limit). Used by the FUSE helper's close-time PUT
   * (mediated by the daemon's IPC handler in-process) and by tests.
   */
  async putRaw(
    orgId: string,
    driveId: string,
    path: string,
    bytes: Uint8Array,
    opts: { ifMatch?: number; contentHash?: string; message?: string } = {}
  ): Promise<{
    version: number;
    path: string;
    deduped: boolean;
    contentHash: string | null;
    size: number;
  }> {
    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }
    if (opts.ifMatch !== undefined) {
      headers.set("If-Match", String(opts.ifMatch));
    }
    if (opts.contentHash) {
      headers.set("X-Agent-FS-Content-Hash", opts.contentHash);
    }
    if (opts.message) {
      // Header values must be Latin-1; fetch's Headers throws on a raw
      // non-ASCII message (e.g. an em dash). Percent-encode for transport
      // and flag it so the server knows to decode it back on read (an
      // unflagged header is trusted as a literal, e.g. "50% done").
      headers.set("X-Agent-FS-Message", encodeURIComponent(opts.message));
      headers.set("X-Agent-FS-Message-Encoding", "percent");
    }
    // The server's raw route matches everything between `/files/` and
    // `/raw`. The path may already start with `/`; strip leading slashes
    // so URI encoding doesn't double them up.
    const encoded = encodeURI(path.replace(/^\/+/, ""));
    const url = `${this.baseUrl}/orgs/${orgId}/drives/${driveId}/files/${encoded}/raw`;

    // Cast the Uint8Array body via BufferSource. fetch's lib.dom type is
    // tighter than the runtime accepts. Bun handles it directly.
    const res = await this.fetchWithTimeout(
      url,
      { method: "PUT", headers, body: bytes as BodyInit },
      false
    );

    let body: any;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `Unexpected response from daemon (${res.status}): ${text || "empty"}`
      );
    }
    if (!res.ok) {
      const msg = body.message ?? body.error ?? "Request failed";
      const suggestion = body.suggestion ? `\n  Suggestion: ${body.suggestion}` : "";
      throw new Error(`${msg}${suggestion}`);
    }
    return {
      version: body.version,
      path: body.path ?? path,
      deduped: Boolean(body.deduped),
      contentHash: res.headers.get("X-Agent-FS-Content-Hash") ?? body.contentHash ?? null,
      size: body.size ?? bytes.length,
    };
  }

  async getRaw(
    orgId: string,
    driveId: string,
    path: string
  ): Promise<{
    bytes: Uint8Array;
    contentType: string | null;
    version: number | null;
    contentHash: string | null;
  }> {
    const headers = new Headers();
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }
    const encoded = encodeURI(path.replace(/^\/+/, ""));
    const url = `${this.baseUrl}/orgs/${orgId}/drives/${driveId}/files/${encoded}/raw`;

    const res = await this.fetchWithTimeout(url, { method: "GET", headers }, true);

    if (!res.ok) {
      let body: any;
      const text = await res.text().catch(() => "");
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(
          `Unexpected response from daemon (${res.status}): ${text || "empty"}`
        );
      }
      const msg = body.message ?? body.error ?? "Request failed";
      const suggestion = body.suggestion ? `\n  Suggestion: ${body.suggestion}` : "";
      throw new Error(`${msg}${suggestion}`);
    }

    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("Content-Type"),
      version: parseOptionalInt(res.headers.get("X-Agent-FS-Version")),
      contentHash: res.headers.get("X-Agent-FS-Content-Hash"),
    };
  }

  private async fetchWithTimeout(
    url: string,
    opts: RequestInit,
    retryTimeout: boolean
  ): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fetch(url, {
          ...opts,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const timedOut = (err as { name?: string }).name === "TimeoutError";
        if ((timedOut && !retryTimeout) || attempt === MAX_RETRIES) {
          if (timedOut) {
            throw new Error(`agent-fs did not answer within ${formatSeconds(this.timeoutMs)} s`);
          }
          throw new Error(
            `Cannot connect to agent-fs daemon at ${this.baseUrl}. Is it running? Start with: agent-fs daemon start`
          );
        }
        await Bun.sleep(100 * 2 ** attempt);
      }
    }
    throw new Error("Unreachable");
  }
}

function getTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_TIMEOUT_MS;
}

function formatSeconds(milliseconds: number): string {
  return String(milliseconds / 1_000);
}

function parseOptionalInt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
