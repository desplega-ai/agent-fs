export { createDatabase, schema } from "./db/index.js";
export type { DB } from "./db/index.js";
export {
  getConfig,
  setConfig,
  setConfigValue,
  getConfigPath,
  getDbPath,
  getHome,
} from "./config.js";
export { isLocalStorageConfig } from "./config.js";
export type {
  AgentFSConfig,
  AgentFSStorageConfig,
  S3StorageConfig,
  LocalStorageConfig,
} from "./config.js";
export { AgentS3Client } from "./s3/index.js";
export type {
  S3Object,
  S3ObjectVersion,
  PutObjectResult,
  GetObjectResult,
  HeadObjectResult,
} from "./s3/index.js";
export type {
  StorageAdapter,
  StorageCapabilities,
} from "./storage/adapter.js";
export { LocalStorageAdapter } from "./storage/local-adapter.js";
export type { LocalStorageAdapterOptions } from "./storage/local-adapter.js";
export { createStorageAdapter } from "./storage/factory.js";
export {
  AgentFSError,
  NotFoundError,
  PermissionDeniedError,
  EditConflictError,
  IndexingInProgressError,
  ValidationError,
  UnsupportedOperation,
} from "./errors.js";
export {
  dispatchOp,
  getRegisteredOps,
  getOpDefinition,
  write,
  writeRaw,
  commentAdd,
  commentList,
  commentGet,
  commentUpdate,
  commentDelete,
  commentResolve,
} from "./ops/index.js";
export {
  getS3Key,
  getNextVersion,
  getHeadContentHash,
  getHeadVersionRow,
  assertExpectedVersion,
  createVersion,
} from "./ops/versioning.js";
export type { HeadVersionRow } from "./ops/versioning.js";
export type { OpContext, OpDefinition } from "./ops/index.js";
export type { WriteParams, WriteRawParams, WriteResult } from "./ops/types.js";
export type {
  CommentAddParams,
  CommentAddResult,
  CommentListParams,
  CommentListResult,
  CommentEntry,
  CommentGetParams,
  CommentGetResult,
  CommentUpdateParams,
  CommentUpdateResult,
  CommentDeleteParams,
  CommentDeleteResult,
  CommentResolveParams,
  CommentResolveResult,
} from "./ops/types.js";
export {
  createUser,
  getUserByApiKey,
  getUserByEmail,
  createOrg,
  listUserOrgs,
  getOrg,
  inviteToOrg,
  listOrgMembers,
  updateOrgMemberRole,
  removeOrgMember,
  createDrive,
  listDrives,
  listDrivesForUser,
  getDrive,
  setDriveMember,
  listDriveMembers,
  updateDriveMemberRole,
  removeDriveMember,
  checkPermission,
  getRequiredRole,
  getUserDriveRole,
  getUserOrgRole,
  roleAtLeast,
  requireDriveRole,
  requireOrgRole,
  requireDriveAdmin,
  assertDriveInOrg,
  resolveContext,
  ensureLocalUser,
} from "./identity/index.js";
export type { Role, ResolvedContext } from "./identity/index.js";
export { VERSION } from "./version.js";
export { createEmbeddingProviderFromEnv } from "./search/embeddings/index.js";
export type { EmbeddingProvider } from "./search/embeddings/index.js";
export { generateOpenAPISpec } from "./openapi.js";
