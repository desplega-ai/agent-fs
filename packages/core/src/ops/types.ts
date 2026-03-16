import type { AgentS3Client } from "../s3/client.js";
import type { DB } from "../db/index.js";
import type { EmbeddingProvider } from "../search/embeddings/provider.js";

export interface OpContext {
  db: DB;
  s3: AgentS3Client;
  orgId: string;
  driveId: string;
  userId: string;
  embeddingProvider?: EmbeddingProvider | null;
}

// --- Param types ---

export interface WriteParams {
  path: string;
  content: string;
  message?: string;
  expectedVersion?: number;
}

export interface CatParams {
  path: string;
  offset?: number;
  limit?: number;
}

export interface EditParams {
  path: string;
  old_string: string;
  new_string: string;
  message?: string;
}

export interface AppendParams {
  path: string;
  content: string;
  message?: string;
}

export interface LsParams {
  path: string;
}

export interface StatParams {
  path: string;
}

export interface RmParams {
  path: string;
}

export interface MvParams {
  from: string;
  to: string;
  message?: string;
}

export interface CpParams {
  from: string;
  to: string;
}

export interface TailParams {
  path: string;
  lines?: number;
}

export interface LogParams {
  path: string;
  limit?: number;
}

export interface DiffParams {
  path: string;
  v1: number;
  v2: number;
}

export interface RevertParams {
  path: string;
  version: number;
}

export interface RecentParams {
  path?: string;
  since?: Date;
  limit?: number;
}

// --- Result types ---

export interface WriteResult {
  version: number;
  path: string;
  size: number;
}

export interface CatResult {
  content: string;
  totalLines: number;
  truncated: boolean;
}

export interface EditResult {
  version: number;
  path: string;
  changes: number;
}

export interface AppendResult {
  version: number;
  size: number;
}

export interface LsEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  author?: string;
  modifiedAt?: Date;
}

export interface LsResult {
  entries: LsEntry[];
}

export interface StatResult {
  path: string;
  size: number;
  contentType?: string;
  author: string;
  currentVersion?: number;
  createdAt: Date;
  modifiedAt: Date;
  isDeleted: boolean;
  embeddingStatus?: string;
}

export interface RmResult {
  path: string;
  deleted: boolean;
}

export interface MvResult {
  from: string;
  to: string;
  version: number;
}

export interface CpResult {
  from: string;
  to: string;
  version: number;
}

export interface VersionEntry {
  version: number;
  author: string;
  createdAt: Date;
  operation: string;
  message?: string;
  diffSummary?: string;
  size?: number;
}

export interface LogResult {
  versions: VersionEntry[];
}

export interface DiffChange {
  type: "add" | "remove" | "context";
  content: string;
  lineNumber?: number;
}

export interface DiffResult {
  changes: DiffChange[];
}

export interface RevertResult {
  version: number;
  revertedTo: number;
}

export interface RecentEntry extends VersionEntry {
  path: string;
}

export interface RecentResult {
  entries: RecentEntry[];
}
