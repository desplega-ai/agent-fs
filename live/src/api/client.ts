import type {
  MeResponse,
  Drive,
  MvResult,
  OrgMembersResult,
  RegisterResponse,
  RmResult,
  SqlResult,
  SqlTableBinding,
  WriteParams,
  WriteResult,
} from "./types"

export interface ApiError {
  error: string
  message: string
  suggestion?: string
  field?: string
  path?: string
  /** HTTP status when the error came from a response (absent for network errors). */
  status?: number
}

/**
 * True when a write was rejected because the path is at a different version
 * than the caller asserted. For create-only writes (`expectedVersion: 0` or
 * `If-None-Match: *`) this means "the file already exists".
 */
export function isConflictError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as Partial<ApiError>
  return e.error === "EDIT_CONFLICT" || e.status === 409
}

export interface PutRawOptions {
  /** Create-only: sends `If-None-Match: *`. A 409 means the path already exists. */
  ifNoneMatch?: boolean
  /** Version message, stored on the new version row. */
  message?: string
  /** Upload progress in bytes. */
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
}

export class AgentFsClient {
  private endpoint: string
  private apiKey: string

  constructor(opts: { endpoint: string; apiKey: string }) {
    // Strip trailing slash
    this.endpoint = opts.endpoint.replace(/\/+$/, "")
    this.apiKey = opts.apiKey
  }

  /**
   * Register a new user account against a given endpoint.
   * Public route (no Authorization header). Mirrors error-shape handling from
   * `request<T>()` so the thrown error has `.error` (e.g. "CONFLICT") and `.message`.
   */
  static async register(opts: { endpoint: string; email: string }): Promise<RegisterResponse> {
    const endpoint = opts.endpoint.replace(/\/+$/, "")
    const res = await fetch(`${endpoint}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: opts.email }),
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

    return res.json() as Promise<RegisterResponse>
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
      throw Object.assign(new Error(body.message), body, { status: res.status })
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

  async getOrgMembers(orgId: string): Promise<OrgMembersResult> {
    return this.get<OrgMembersResult>(`/orgs/${orgId}/members`)
  }

  async getSignedUrl(
    orgId: string,
    driveId: string,
    path: string,
  ): Promise<{ url: string; expiresAt: string; expiresIn?: number; kind?: "presigned" | "app" }> {
    return this.callOp<{ url: string; expiresAt: string; expiresIn?: number; kind?: "presigned" | "app" }>(
      orgId,
      "signed-url",
      { path },
      driveId,
    )
  }

  async sqlQuery(
    orgId: string,
    driveId: string,
    params: { query: string; tables?: Record<string, SqlTableBinding>; maxRows?: number },
  ): Promise<SqlResult> {
    return this.callOp<SqlResult>(orgId, "sql", { ...params }, driveId)
  }

  async write(orgId: string, driveId: string, params: WriteParams): Promise<WriteResult> {
    return this.callOp<WriteResult>(orgId, "write", { ...params }, driveId)
  }

  /** Move or rename a single file. The server overwrites `to` if it exists. */
  async mv(orgId: string, driveId: string, params: { from: string; to: string }): Promise<MvResult> {
    return this.callOp<MvResult>(orgId, "mv", { ...params }, driveId)
  }

  /** Soft-delete a single file (writes a delete-marker version). */
  async rm(orgId: string, driveId: string, params: { path: string }): Promise<RmResult> {
    return this.callOp<RmResult>(orgId, "rm", { ...params }, driveId)
  }

  /**
   * Binary upload to `PUT /orgs/:orgId/drives/:driveId/files/<path>/raw`.
   *
   * Same wire format as the CLI's `putRaw`: Bearer auth, an octet-stream body
   * (the server detects MIME from the extension), `If-None-Match: *` for
   * create-only writes, and a percent-encoded version message. Uses
   * `XMLHttpRequest` because `fetch` exposes no upload progress. Body limit
   * is 50 MB on the server; callers should reject larger files before sending.
   */
  putRaw(
    orgId: string,
    driveId: string,
    path: string,
    body: Blob,
    opts: PutRawOptions = {},
  ): Promise<WriteResult> {
    // Encode the whole path as one segment (slashes become `%2F`), the same
    // shape `getRawUrl` uses. The route's `:filePath{.+}` param does not span
    // literal slashes, so `files/a/b.txt/raw` 404s while `files/a%2Fb.txt/raw`
    // is decoded back to `a/b.txt` by the handler.
    const encoded = encodeURIComponent(path.replace(/^\/+/, ""))
    const url = `${this.endpoint}/orgs/${orgId}/drives/${driveId}/files/${encoded}/raw`

    return new Promise<WriteResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open("PUT", url)
      xhr.responseType = "text"
      xhr.setRequestHeader("Authorization", `Bearer ${this.apiKey}`)
      xhr.setRequestHeader("Content-Type", "application/octet-stream")
      if (opts.ifNoneMatch) xhr.setRequestHeader("If-None-Match", "*")
      if (opts.message) {
        xhr.setRequestHeader("X-Agent-FS-Message", encodeURIComponent(opts.message))
        xhr.setRequestHeader("X-Agent-FS-Message-Encoding", "percent")
      }

      const onProgress = opts.onProgress
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total)
        }
      }

      xhr.onload = () => {
        let parsed: unknown = null
        try {
          parsed = JSON.parse(xhr.responseText)
        } catch {
          parsed = null
        }
        if (xhr.status >= 200 && xhr.status < 300 && parsed) {
          resolve(parsed as WriteResult)
          return
        }
        const apiError: ApiError =
          parsed && typeof (parsed as ApiError).message === "string"
            ? (parsed as ApiError)
            : { error: "UNKNOWN", message: xhr.statusText || `HTTP ${xhr.status}` }
        reject(Object.assign(new Error(apiError.message), apiError, { status: xhr.status }))
      }
      xhr.onerror = () => {
        reject(Object.assign(new Error(`Cannot reach ${this.endpoint}`), { error: "NETWORK" }))
      }
      xhr.onabort = () => {
        reject(Object.assign(new Error("Upload cancelled"), { error: "ABORTED" }))
      }

      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(Object.assign(new Error("Upload cancelled"), { error: "ABORTED" }))
          return
        }
        opts.signal.addEventListener("abort", () => xhr.abort(), { once: true })
      }

      xhr.send(body)
    })
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
