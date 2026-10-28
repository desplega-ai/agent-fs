export { createDatabase, schema } from "./db/index.js";
export type { DB } from "./db/index.js";
export {
  prepareFtsMigration,
  runFtsMigration,
  hasLegacyFts,
} from "./db/fts-migration.js";
export type { FtsMigrationResult } from "./db/fts-migration.js";
export {
  getConfig,
  getMaxUploadBytes,
  getRegisterAllowedDomains,
  DEFAULT_MAX_UPLOAD_BYTES,
  setConfig,
  setConfigValue,
  getConfigPath,
  getDbPath,
  getHome,
} from "./config.js";
export { isLocalStorageConfig } from "./config.js";
export { startServerTelemetry } from "./telemetry.js";
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
  EmbeddingProviderError,
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
  driveMembers,
  favoriteAdd,
  favoriteRemove,
  favoriteList,
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
export {
  shareCreate,
  shareRevoke,
  findShareByToken,
  getShareState,
  authorizeShareBytes,
  consumeShareView,
  openShareView,
  shareStorageKey,
  siteObjectKey,
  capUrlTtlSeconds,
  presignShareUrl,
  presignedUrlDeadline,
  recordShareViewed,
  isWellFormedShareToken,
  extractShareToken,
  SHARE_DEFAULT_TTL_SECONDS,
  SHARE_MAX_TTL_SECONDS,
  SHARE_VIEW_GRANT_TTL_SECONDS,
} from "./ops/share.js";
export type {
  ShareRecord,
  ShareKind,
  ShareState,
  ShareCreateResult,
  ShareRevokeResult,
  ShareByteAccess,
  ShareViewGrant,
  OpenedShareView,
} from "./ops/share.js";
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
  DriveMembersParams,
  DriveMember,
  DriveMembersResult,
} from "./ops/types.js";
export {
  createUser,
  getProfile,
  updateProfile,
  profileUpdateSchema,
  getUserByApiKey,
  getUserByEmail,
  resetApiKey,
  resetApiKeyOrgless,
  createOrg,
  listUserOrgs,
  getOrg,
  inviteToOrg,
  addDriveMember,
  listOrgMembers,
  updateOrgMemberRole,
  removeOrgMember,
  INVITE_TTL_SECONDS,
  acceptInvite,
  getInvitePreview,
  listInvites,
  revokeInvite,
  parseInviteToken,
  inviteAcceptUrl,
  createDrive,
  listDrives,
  listDrivesForUser,
  listManageableDrives,
  getDrive,
  setDriveMember,
  listDriveMembers,
  listDriveMembersPublic,
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
export type {
  Role,
  ResolvedContext,
  ResetApiKeyResult,
  MemberRole,
  DriveGrant,
  InviteResult,
  AddedInviteResult,
  PendingInviteResult,
  InvitePreview,
  AcceptInviteResult,
} from "./identity/index.js";
export { VERSION } from "./version.js";
export { publishDriveEvent, subscribeDrive } from "./events/bus.js";
export type { DriveEvent } from "./events/bus.js";
export { loadTransformers } from "./search/embeddings/embeddinggemma.js";
export { createEmbeddingProviderFromEnv, NOMIC_MODEL, EMBEDDINGGEMMA_MODEL } from "./search/embeddings/index.js";
export {
  runEmbeddingMigration,
  migrationCpuShare,
  storedFormat,
  hasChunks,
} from "./search/embedding-migration.js";
export { canRenderPdfPages } from "./search/pdf.js";
export { prepareImageEmbeddings, scheduleImageEmbeddings } from "./search/image-embedding.js";
export { startVectorSearchWorker } from "./search/vector-worker.js";
export type { EmbeddingProvider } from "./search/embeddings/index.js";
export { generateOpenAPISpec } from "./openapi.js";

export * from "./presence/index.js";
