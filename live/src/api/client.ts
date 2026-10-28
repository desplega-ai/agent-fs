import type {
  AcceptInviteResult,
  AddDriveMemberResult,
  DriveGrant,
  DriveMemberWithRole,
  InvitePreview,
  InviteResult,
  ManageableDrive,
  MemberRole,
  MeResponse,
  Drive,
  MvResult,
  Org,
  OrgMembersResult,
  PendingInvite,
  RegisterResponse,
  RmResult,
  FavoriteListResult,
  PresenceSession,
  PresenceSnapshot,
  PresenceState,
  SqlResult,
  SqlTableBinding,
  WriteParams,
  WriteResult,
} from "./types"

/** Mirrors the `disposition` param of the core `signed-url` op. */
export type SignedUrlDisposition = "inline" | "attachment"

/** Result of the core `share-create` op. */
export interface ShareCreateResult {
  id: string
  /** `site` when `path` is a folder. Absent on servers older than site shares. */
  kind?: "file" | "site"
  /** Absolute when the server knows its public address, otherwise the same as `sharePath`. */
  url: string
  /**
   * `configured` (url built on AGENT_FS_PUBLIC_URL) or `request` (from the
   * request's Host). Absent on older servers. Unchecked: validate before use.
   */
  urlSource?: unknown
  /** Host-relative link: `/share/<token>` for a file, `/site/<token>/` for a folder. */
  sharePath: string
  path: string
  expiresIn: number
  expiresAt: string
  /** `null` = unlimited, `1` = one-off. */
  maxViews: number | null
}

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
  readonly endpoint: string
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

  /**
   * Public preview of an accept link: who invited you, to which org and drives.
   * The token is the credential, so no Authorization header. Unknown, expired,
   * revoked and used links all answer the same 404.
   */
  static async getInvitePreview(opts: { endpoint: string; token: string }): Promise<InvitePreview> {
    const endpoint = opts.endpoint.replace(/\/+$/, "")
    const res = await fetch(`${endpoint}/invites/${encodeURIComponent(opts.token)}`)
    if (!res.ok) {
      let body: ApiError
      try {
        body = await res.json()
      } catch {
        body = { error: "UNKNOWN", message: res.statusText }
      }
      throw Object.assign(new Error(body.message), body, { status: res.status })
    }
    return res.json() as Promise<InvitePreview>
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

  async get<T>(path: string, opts?: RequestInit): Promise<T> {
    return this.request<T>(path, opts)
  }

  async post<T>(path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      signal: opts?.signal,
    })
  }

  /** Pass `opts.signal` to let TanStack Query abort a request whose result nobody reads. */
  async callOp<T>(
    orgId: string,
    op: string,
    params: Record<string, unknown> = {},
    driveId?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<T> {
    const body: Record<string, unknown> = { op, ...params }
    if (driveId) body.driveId = driveId
    return this.post<T>(`/orgs/${orgId}/ops`, body, opts)
  }

  async updateProfile(displayName: string | null): Promise<{ userId: string; email: string; displayName: string | null }> {
    return this.request("/auth/profile", { method: "PATCH", body: JSON.stringify({ displayName }) })
  }

  async getMe(): Promise<MeResponse> {
    return this.get<MeResponse>("/auth/me")
  }

  async getOrgs(): Promise<{ orgs: Org[] }> {
    return this.get<{ orgs: Org[] }>("/orgs")
  }

  async getDrives(orgId: string): Promise<{ drives: Drive[] }> {
    return this.get<{ drives: Drive[] }>(`/orgs/${orgId}/drives`)
  }

  async getOrgMembers(orgId: string): Promise<OrgMembersResult> {
    return this.get<OrgMembersResult>(`/orgs/${orgId}/members`)
  }

  /** Every drive whose members the caller can manage (all drives for an org admin). */
  async getManageableDrives(orgId: string): Promise<{ drives: ManageableDrive[] }> {
    return this.get<{ drives: ManageableDrive[] }>(`/orgs/${orgId}/drives?scope=manageable`)
  }

  /** Drive members with their roles. 403 unless the caller is a drive admin or an org admin. */
  async getDriveMembersAdmin(orgId: string, driveId: string): Promise<{ members: DriveMemberWithRole[] }> {
    return this.get<{ members: DriveMemberWithRole[] }>(`/orgs/${orgId}/drives/${driveId}/members`)
  }

  /** Add an existing org member to a drive, or change their role when already on it. */
  async addDriveMember(
    orgId: string,
    driveId: string,
    params: { email: string; role: MemberRole } | { userId: string; role: MemberRole },
  ): Promise<AddDriveMemberResult> {
    return this.post<AddDriveMemberResult>(`/orgs/${orgId}/drives/${driveId}/members`, params)
  }

  async updateDriveMemberRole(orgId: string, driveId: string, userId: string, role: MemberRole): Promise<void> {
    await this.request(`/orgs/${orgId}/drives/${driveId}/members/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    })
  }

  async removeDriveMember(orgId: string, driveId: string, userId: string): Promise<void> {
    await this.request(`/orgs/${orgId}/drives/${driveId}/members/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    })
  }

  /**
   * Invite `email` to the org with a role per drive. Someone with an account is
   * added at once; an unknown email gets a pending invite whose one-time token
   * comes back in the response. Invite an existing org member again and their
   * org role is overwritten, so add them to drives with `addDriveMember` instead.
   */
  async inviteToOrg(
    orgId: string,
    params: { email: string; role: MemberRole; drives: DriveGrant[] },
  ): Promise<InviteResult> {
    return this.post<InviteResult>(`/orgs/${orgId}/members/invite`, params)
  }

  /** Open invites of the org. 403 unless the caller is an org admin. */
  async getInvites(orgId: string): Promise<{ invites: PendingInvite[] }> {
    return this.get<{ invites: PendingInvite[] }>(`/orgs/${orgId}/invites`)
  }

  async revokeInvite(orgId: string, inviteId: string): Promise<void> {
    await this.request(`/orgs/${orgId}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" })
  }

  /** Accept an invite as the signed-in user. The invite email must match their account. */
  async acceptInvite(token: string): Promise<AcceptInviteResult> {
    return this.post<AcceptInviteResult>(`/invites/${encodeURIComponent(token)}/accept`, {})
  }

  /**
   * Mint a signed URL for `path`. The server defaults `disposition` to
   * `attachment` (forces a download); pass `inline` for URLs that will be
   * rendered by the browser, such as a PDF in an <iframe>.
   */
  async getSignedUrl(
    orgId: string,
    driveId: string,
    path: string,
    options?: { disposition?: SignedUrlDisposition; signal?: AbortSignal },
  ): Promise<{ url: string; expiresAt: string; expiresIn?: number; kind?: "presigned" | "app" }> {
    return this.callOp<{ url: string; expiresAt: string; expiresIn?: number; kind?: "presigned" | "app" }>(
      orgId,
      "signed-url",
      options?.disposition ? { path, disposition: options.disposition } : { path },
      driveId,
      { signal: options?.signal },
    )
  }

  /** Mint a public `/share/<token>` link for `path`. The server defaults to 24 hours. */
  async createShare(
    orgId: string,
    driveId: string,
    path: string,
    options?: { expiresIn?: number; maxViews?: number },
  ): Promise<ShareCreateResult> {
    return this.callOp<ShareCreateResult>(orgId, "share-create", { path, ...options }, driveId)
  }

  async listFavorites(orgId: string, driveId: string, opts?: { signal?: AbortSignal }): Promise<FavoriteListResult> {
    return this.callOp<FavoriteListResult>(orgId, "favorite-list", {}, driveId, opts)
  }

  /** Star or unstar `path` for the signed-in user. The server takes the user from the API key. */
  async setFavorite(orgId: string, driveId: string, path: string, favorite: boolean): Promise<void> {
    await this.callOp(orgId, favorite ? "favorite-add" : "favorite-remove", { path }, driveId)
  }

  /** Who is on the drive right now (presence fallback when the event stream is unavailable). */
  async getPresence(orgId: string, driveId: string, opts?: { signal?: AbortSignal }): Promise<PresenceSnapshot> {
    return this.get<PresenceSnapshot>(`/orgs/${orgId}/drives/${driveId}/presence`, { signal: opts?.signal })
  }

  /** Publish this tab's presence. The server stamps who it is from the API key. */
  async putPresence(orgId: string, driveId: string, sessionId: string, state: PresenceState): Promise<{ session: PresenceSession }> {
    return this.request(`/orgs/${orgId}/drives/${driveId}/presence/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      body: JSON.stringify(state),
    })
  }

  /** `keepalive` lets the request outlive the page (sent from `pagehide`). */
  async deletePresence(orgId: string, driveId: string, sessionId: string, opts?: { keepalive?: boolean }): Promise<void> {
    await this.request(`/orgs/${orgId}/drives/${driveId}/presence/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      keepalive: opts?.keepalive,
    })
  }

  /**
   * Open the drive's SSE change-stream with presence frames (`presence=1`),
   * bound to `sessionId` so the server drops the session when the stream
   * closes. Returns the raw response: `EventSource` cannot send the Bearer
   * header, so the caller reads `body` itself.
   */
  async openDriveEvents(orgId: string, driveId: string, opts: { sessionId: string; signal?: AbortSignal }): Promise<Response> {
    const query = new URLSearchParams({ presence: "1", sessionId: opts.sessionId })
    return fetch(`${this.endpoint}/orgs/${orgId}/drives/${driveId}/events?${query}`, {
      cache: "no-store",
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.apiKey}` },
      signal: opts.signal,
    })
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
   * is reported by /health; callers should reject larger files before sending.
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

  /**
   * The raw route answers with `max-age=60`; reads default to `no-store` so an
   * edited file is never served from the browser cache.
   */
  async fetchRawResponse(
    orgId: string,
    driveId: string,
    path: string,
    init?: Omit<RequestInit, "headers">,
  ): Promise<Response> {
    const url = this.getRawUrl(orgId, driveId, path)
    const res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch raw: ${res.statusText}`)
    return res
  }

  async fetchRaw(orgId: string, driveId: string, path: string, init?: Omit<RequestInit, "headers">): Promise<Blob> {
    return (await this.fetchRawResponse(orgId, driveId, path, init)).blob()
  }

  /**
   * A URL the browser can load for `path`. Backends without presigned URLs
   * answer `signed-url` with an `app` link, which is the viewer page rather
   * than the bytes; those are read through the authenticated raw route into
   * an object URL that the caller must revoke.
   */
  async fetchableUrl(
    orgId: string,
    driveId: string,
    path: string,
    options?: { disposition?: SignedUrlDisposition; signal?: AbortSignal },
  ): Promise<{ url: string; expiresAt: string; objectUrl: boolean }> {
    const result = await this.getSignedUrl(orgId, driveId, path, options)
    if (result.kind !== "app") return { url: result.url, expiresAt: result.expiresAt, objectUrl: false }
    const blob = await this.fetchRaw(orgId, driveId, path, { signal: options?.signal })
    return { url: URL.createObjectURL(blob), expiresAt: "", objectUrl: true }
  }
}
