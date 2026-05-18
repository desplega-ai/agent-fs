import { getConfig } from "@/core";

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;

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
  }

  private async request(path: string, opts?: RequestInit): Promise<any> {
    const headers = new Headers(opts?.headers);
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }
    headers.set("Content-Type", "application/json");

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...opts, headers });
    } catch (err) {
      throw new Error(
        `Cannot connect to agent-fs daemon at ${this.baseUrl}. Is it running? Start with: agent-fs daemon start`
      );
    }

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
    return this.post(`/orgs/${orgId}/ops`, { op, ...params });
  }

  async getMe(): Promise<{ userId: string; email: string; defaultOrgId: string | null; defaultDriveId: string | null }> {
    return this.get("/auth/me");
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  /**
   * Binary upload to `PUT /orgs/:orgId/drives/:driveId/files/<path>/raw`.
   *
   * Bypasses the JSON op path so the body can exceed the 10 MB JSON cap (up
   * to Hono's 50 MB body limit). Used by the FUSE helper's close-time PUT
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
      headers.set("X-Agent-FS-Message", opts.message);
    }
    // The server's GET handler matches the wildcard between `/files/` and
    // `/raw`. The path may already start with `/`; strip leading slashes
    // so URI encoding doesn't double them up.
    const encoded = encodeURI(path.replace(/^\/+/, ""));
    const url = `${this.baseUrl}/orgs/${orgId}/drives/${driveId}/files/${encoded}/raw`;

    let res: Response;
    try {
      // Cast the Uint8Array body via BufferSource — fetch's lib.dom type is
      // tighter than the runtime accepts (Bun handles it directly).
      res = await fetch(url, { method: "PUT", headers, body: bytes as BodyInit });
    } catch (err) {
      throw new Error(
        `Cannot connect to agent-fs daemon at ${this.baseUrl}. Is it running? Start with: agent-fs daemon start`
      );
    }

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
      deduped: Boolean(body.deduped),
      contentHash: res.headers.get("X-Agent-FS-Content-Hash") ?? body.contentHash ?? null,
      size: body.size ?? bytes.length,
    };
  }
}
