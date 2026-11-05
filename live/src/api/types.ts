// Response types — manually ported from packages/core/src/ops/types.ts
// All Date fields are ISO-8601 strings on the wire.

export interface LsEntry {
  name: string
  type: "file" | "directory"
  size: number
  author?: string
  modifiedAt?: string
}

export interface LsResult {
  entries: LsEntry[]
}

export interface TreeEntry {
  name: string
  type: "file" | "directory"
  size?: number
  author?: string
  modifiedAt?: string
  children?: TreeEntry[]
}

export interface TreeResult {
  tree: TreeEntry[]
}

export interface CatResult {
  content: string
  totalLines: number
  truncated: boolean
}

export interface StatResult {
  path: string
  size: number
  contentType?: string
  author: string
  currentVersion?: number
  createdAt: string
  modifiedAt: string
  isDeleted: boolean
  embeddingStatus?: string
  /** Storage ETag of the current bytes (newer servers only). Opaque. */
  etag?: string
}

/** Result of the `reveal` op: every ancestor's `ls` listing, root first. */
export interface RevealResult {
  path: string
  stat: StatResult
  listings: { path: string; entries: LsEntry[] }[]
}

export interface VersionEntry {
  version: number
  author: string
  createdAt: string
  operation: string
  message?: string
  diffSummary?: string
  size?: number
}

export interface LogResult {
  versions: VersionEntry[]
}

export interface DiffChange {
  type: "add" | "remove" | "context"
  content: string
  lineNumber?: number
  /** 1-based line in v1; absent on servers that predate line numbers. */
  oldLine?: number
  /** 1-based line in v2; absent on servers that predate line numbers. */
  newLine?: number
}

/**
 * Which path produced a DiffResult:
 * - "content": both versions were compared line by line.
 * - "summary": not compared; `changes` is v2's stored edit snippet.
 * - "none": not compared and no stored summary; empty `changes` does NOT mean
 *   the versions are identical.
 */
export type DiffSource = "content" | "summary" | "none"

export interface DiffResult {
  changes: DiffChange[]
  /** Absent on servers that predate it; never read its absence as "content". */
  source?: DiffSource
}

export interface RecentEntry extends VersionEntry {
  path: string
}

export interface RecentResult {
  entries: RecentEntry[]
}

export interface GlobMatch {
  path: string
  size: number
  modifiedAt?: string
}

export interface GlobResult {
  matches: GlobMatch[]
}

export interface FindMatch {
  path: string
  size: number
  modifiedAt?: string
  score: number
}

export interface FindResult {
  /** Best first, capped at the request's `limit`. */
  matches: FindMatch[]
  /** Number of matching files before the cap. */
  total: number
}

// Comment types

export interface CommentQuote {
  exact: string
  prefix?: string
  suffix?: string
}

export interface CommentEntry {
  id: string
  parentId?: string
  path: string
  lineStart?: number
  lineEnd?: number
  quotedContent?: string
  quote?: CommentQuote
  body: string
  author: string
  authorDisplayName?: string
  resolved: boolean
  resolvedBy?: string
  resolvedAt?: string
  fileVersionId?: number
  /** Version number of fileVersionId; absent on older servers. */
  fileVersion?: number
  replyCount: number
  createdAt: string
  updatedAt: string
}

export interface CommentListEntry extends CommentEntry {
  replies: CommentEntry[]
}

export interface CommentListResult {
  comments: CommentListEntry[]
}

export interface CommentGetResult {
  comment: CommentEntry
  replies: CommentEntry[]
}

export interface CommentAddResult {
  id: string
  path: string
  body: string
  parentId?: string
  lineStart?: number
  lineEnd?: number
  author: string
  authorDisplayName?: string
  createdAt: string
}

export interface CommentUpdateResult {
  id: string
  body: string
  updatedAt: string
}

export interface CommentDeleteResult {
  deleted: boolean
}

export interface CommentResolveResult {
  id: string
  resolved: boolean
  resolvedBy?: string
  resolvedAt?: string
}

export interface CommentNotificationEntry {
  id: string
  commentId: string
  parentId?: string
  path: string
  body: string
  actor: string
  actorDisplayName?: string
  createdAt: string
  read: boolean
}

export interface CommentNotificationListResult {
  notifications: CommentNotificationEntry[]
  unreadCount: number
}

export interface CommentNotificationReadResult {
  markedRead: number
}

// FTS types (from core/ops/fts.ts)

export interface FtsOpMatch {
  path: string
  snippet: string
  rank: number
}

export interface FtsResult {
  matches: FtsOpMatch[]
  hint?: string
  /** Server time for the query, in milliseconds (servers from 0.16.8). */
  tookMs?: number
}

// Search types (from core/ops/search.ts)

export interface SearchResultItem {
  path: string
  score: number
  snippet: string
  /** What the best semantic chunk holds (servers from 0.17.4). */
  kind?: "text" | "image"
  /** PDF page of the best semantic chunk (servers from 0.17.3). */
  page?: number
  author?: string
  modifiedAt?: string
}

export interface SearchResult {
  results: SearchResultItem[]
  hint?: string
  /** Server time for the search, in milliseconds (servers from 0.16.8). */
  tookMs?: number
}

// Grep types (from core/ops/grep.ts)

export interface GrepMatch {
  path: string
  lineNumber: number
  content: string
}

export interface GrepResult {
  matches: GrepMatch[]
}

// SQL types (from core/ops/types.ts)

export type SqlFormat =
  | "csv"
  | "tsv"
  | "parquet"
  | "xlsx"
  | "json"
  | "ndjson"
  | "sqlite"
  | "duckdb"

/** Named table binding: document path, or { path, format } to override format detection. */
export type SqlTableBinding = string | { path: string; format?: SqlFormat }

export interface SqlColumn {
  name: string
  type: string
}

export interface SqlBoundFile {
  table: string
  path: string
  format: SqlFormat
}

export interface SqlResult {
  columns: SqlColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  files: SqlBoundFile[]
  elapsedMs: number
}

// Write types (from core/ops/types.ts)

export interface WriteParams {
  path: string
  content: string
  message?: string
  expectedVersion?: number
}

export interface WriteResult {
  version: number
  path: string
  size: number
  contentHash?: string
  deduped?: boolean
}

// Auth types

export interface OrgMember {
  userId: string
  email: string
  role: string
}

export interface OrgMembersResult {
  members: OrgMember[]
}

export interface DriveMember {
  userId: string
  email: string
  displayName: string | null
}

export interface DriveMembersResult {
  members: DriveMember[]
}

export type MemberRole = "viewer" | "editor" | "admin"

/** A drive member as the admin endpoint lists them: with their drive role. */
export interface DriveMemberWithRole {
  userId: string
  email: string
  role: MemberRole
}

export interface AddDriveMemberResult {
  userId: string
  email: string
  driveId: string
  role: MemberRole
  /** False when the person was already on the drive and only their role changed. */
  created: boolean
}

/** A drive the caller can manage members on. `myRole` is null for an org admin who is not on it. */
export interface ManageableDrive {
  id: string
  name: string
  isDefault: boolean
  myRole: MemberRole | null
}

/** One drive an invite grants, with the role the person gets on it. */
export interface DriveGrant {
  driveId: string
  role: MemberRole
}

/** `POST /orgs/:orgId/members/invite` for someone already in the org. */
export interface InviteAddedResult {
  status: "added"
  userId: string
  email: string
  /** Absent on servers that predate it. */
  orgRole?: MemberRole
  drives: DriveGrant[]
}

/** `POST /orgs/:orgId/members/invite` for someone not in the org yet, with or without an account. */
export interface InvitePendingResult {
  status: "pending"
  inviteId: string
  email: string
  /** Shown once; only its hash is stored. */
  token: string
  expiresAt: string
  drives: DriveGrant[]
  /** Built from the server's configured app URL. Absent when none is set. */
  acceptUrl?: string
}

export type InviteResult = InviteAddedResult | InvitePendingResult

/** An open invite as the org admin lists it. The token is not part of it. */
export interface PendingInvite {
  id: string
  email: string
  orgRole: MemberRole
  drives: DriveGrant[]
  createdBy: string
  createdAt: string
  expiresAt: string
  expired: boolean
}

/** What the holder of an accept link sees before signing in. */
export interface InvitePreview {
  orgId: string
  orgName: string
  invitedBy: string
  email: string
  drives: { driveId: string; name: string; role: MemberRole }[]
  expiresAt: string
}

export interface AcceptInviteResult {
  orgId: string
  role: MemberRole
  drives: DriveGrant[]
  /** Drives named in the invite that were deleted before it was accepted. */
  skippedDrives: string[]
}

/**
 * `GET /auth/me`. An org-scoped key (minted by an org admin) gets identity
 * only: `scopedOrgId` is set and the personal defaults are absent.
 */
export interface MeResponse {
  displayName?: string | null
  userId: string
  email: string
  /** Absent for an org-scoped key. */
  defaultOrgId?: string | null
  /** Absent for an org-scoped key. */
  defaultDriveId?: string | null
  /** Org the signed-in key is limited to; null for an unscoped key. Absent on servers that predate it. */
  scopedOrgId?: string | null
}

export interface RegisterResponse {
  apiKey: string
  userId: string
  orgId: string
}

export interface Drive {
  id: string
  name: string
  orgId: string
}

export interface Org {
  id: string
  name: string
  /** The caller's role in the org. Absent on servers that predate it. */
  role?: MemberRole
}

// File mutation ops (mv / rm)

export interface MvResult {
  from: string
  to: string
  version: number
}

export interface RmResult {
  path: string
  deleted: boolean
}

export interface Favorite {
  /** Server form: leading slash, no trailing slash. */
  path: string
  kind: "file" | "directory"
  createdAt: string
}

export interface FavoriteListResult {
  favorites: Favorite[]
}

// Presence (live UI only). Mirrors packages/core/src/presence/types.ts.

export interface PresenceQuote {
  /** At most 256 chars. */
  exact: string
  /** At most 64 chars each. */
  prefix?: string
  suffix?: string
}

/** A text selection, or the text caret when `collapsed`. */
export interface PresenceSelection {
  quote: PresenceQuote
  lineStart: number
  lineEnd: number
  fileVersion?: number | null
  collapsed: boolean
}

/** A point in the text (the mouse pointer): `charOffset` chars into the quote. */
export interface PresenceTextPos {
  quote: PresenceQuote
  charOffset: number
  lineStart: number
  fileVersion?: number | null
}

/** Body of `PUT .../presence/:sessionId`. */
export interface PresenceState {
  /** null = on the drive, no doc open. */
  path: string | null
  mode: "view" | "edit"
  selection?: PresenceSelection | null
  pointer?: PresenceTextPos | null
  commentId?: string | null
  commentState?: "viewing" | "replying" | null
}

export interface PresenceSession extends PresenceState {
  sessionId: string
  userId: string
  email: string
  displayName: string | null
  /** ISO time of the last state change. */
  updatedAt: string
}

export interface PresenceSnapshot {
  driveId: string
  sessions: PresenceSession[]
  at: string
}

export type PresenceEvent =
  | { type: "presence.updated"; driveId: string; session: PresenceSession; at: string }
  | { type: "presence.left"; driveId: string; sessionId: string; userId: string; at: string }

/** One of the caller's active API keys, from `GET /auth/keys`. Never carries a secret. */
export interface ApiKeyInfo {
  /** `primary` for the key register and reset-key hand out. */
  id: string
  label: string
  /** Null for the primary key. */
  createdAt: string | null
  /** Null until first use, and always for the primary key. */
  lastUsedAt: string | null
  primary: boolean
  /** Org the key is limited to; null for a key that reaches the whole account. */
  orgId: string | null
  createdByUserId: string
  /** True for the key this browser signs in with. Absent on servers that predate it. */
  current?: boolean
}

/** `POST /auth/keys`: the plaintext key, returned this once. */
export interface CreatedApiKey {
  id: string
  label: string
  createdAt: string
  apiKey: string
}

export type ShareListStatus = "active" | "expired" | "exhausted" | "revoked"

/** One link from the core `share-list` op. Never carries the token or anything that rebuilds the URL. */
export interface ShareListItem {
  id: string
  /** `name` is null for a drive that no longer exists. */
  drive: { id: string; name: string | null }
  /** The folder path for a `site` link. */
  path: string
  kind: "file" | "site"
  /** Set only when the list was asked for one path: `covering` is a link on a parent folder. */
  relation?: "exact" | "covering"
  status: ShareListStatus
  createdAt: string
  createdBy: { userId: string; email: string | null; displayName: string | null }
  /** Null for a link that never expires. */
  expiresAt: string | null
  views: number
  maxViews: number | null
  lastViewedAt: string | null
  revokedAt: string | null
  /** The creator, or an admin of the link's drive. */
  canRevoke: boolean
  appUrl?: string
}

export interface ShareListResult {
  shares: ShareListItem[]
  total: number
  limit: number
  offset: number
  scope: "drive" | "mine"
  /** `all`: every member's links (drive admins). `own`: only the caller's links. */
  visibility: "all" | "own"
}

export interface ShareListParams {
  scope?: "drive" | "mine"
  path?: string
  includeInactive?: boolean
  limit?: number
  offset?: number
}
