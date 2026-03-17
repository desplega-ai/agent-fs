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
}

export interface DiffResult {
  changes: DiffChange[]
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

export interface CommentEntry {
  id: string
  parentId?: string
  path: string
  lineStart?: number
  lineEnd?: number
  quotedContent?: string
  body: string
  author: string
  resolved: boolean
  resolvedBy?: string
  resolvedAt?: string
  fileVersionId?: number
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

// Auth types

export interface MeResponse {
  userId: string
  email: string
  defaultOrgId: string | null
  defaultDriveId: string | null
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
