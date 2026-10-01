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
}

// Search types (from core/ops/search.ts)

export interface SearchResultItem {
  path: string
  score: number
  snippet: string
  author?: string
  modifiedAt?: string
}

export interface SearchResult {
  results: SearchResultItem[]
  hint?: string
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

export interface MeResponse {
  displayName?: string | null
  userId: string
  email: string
  defaultOrgId: string | null
  defaultDriveId: string | null
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
