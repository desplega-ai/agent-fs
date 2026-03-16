import { getConfig } from "@/core";

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    const config = getConfig();
    this.baseUrl =
      process.env.AGENT_FS_API_URL ??
      `http://${config.server.host}:${config.server.port}`;
    this.apiKey = process.env.AGENT_FS_API_KEY ?? config.auth.apiKey;
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

  async callOp(orgId: string, op: string, params: Record<string, any>): Promise<any> {
    return this.post(`/orgs/${orgId}/ops`, { op, ...params });
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }
}
