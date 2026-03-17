import type { MeResponse, Drive } from "./types"

export interface ApiError {
  error: string
  message: string
  suggestion?: string
  field?: string
  path?: string
}

export class AgentFsClient {
  private endpoint: string
  private apiKey: string

  constructor(opts: { endpoint: string; apiKey: string }) {
    // Strip trailing slash
    this.endpoint = opts.endpoint.replace(/\/+$/, "")
    this.apiKey = opts.apiKey
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const url = `${this.endpoint}${path}`
    const res = await fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...opts?.headers,
      },
    })

    if (!res.ok) {
      let body: ApiError
      try {
        body = await res.json()
      } catch {
        body = { error: "UNKNOWN", message: res.statusText }
      }
      throw Object.assign(new Error(body.message), body)
    }

    return res.json()
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path)
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  async callOp<T>(orgId: string, op: string, params: Record<string, unknown> = {}, driveId?: string): Promise<T> {
    const body: Record<string, unknown> = { op, ...params }
    if (driveId) body.driveId = driveId
    return this.post<T>(`/orgs/${orgId}/ops`, body)
  }

  async getMe(): Promise<MeResponse> {
    return this.get<MeResponse>("/auth/me")
  }

  async getOrgs(): Promise<{ orgs: { id: string; name: string }[] }> {
    return this.get<{ orgs: { id: string; name: string }[] }>("/orgs")
  }

  async getDrives(orgId: string): Promise<{ drives: Drive[] }> {
    return this.get<{ drives: Drive[] }>(`/orgs/${orgId}/drives`)
  }

  getRawUrl(orgId: string, driveId: string, path: string): string {
    return `${this.endpoint}/orgs/${orgId}/drives/${driveId}/files/${encodeURIComponent(path)}/raw`
  }

  async fetchRaw(orgId: string, driveId: string, path: string): Promise<Blob> {
    const url = this.getRawUrl(orgId, driveId, path)
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch raw: ${res.statusText}`)
    return res.blob()
  }
}
