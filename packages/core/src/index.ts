export { createDatabase, schema } from "./db/index.js";
export type { DB } from "./db/index.js";
export {
  getConfig,
  setConfig,
  setConfigValue,
  getConfigPath,
  getDbPath,
  getAgentFSHome,
} from "./config.js";
export type { AgentFSConfig } from "./config.js";
export { AgentS3Client } from "./s3/index.js";
export type {
  S3Object,
  S3ObjectVersion,
  PutObjectResult,
  GetObjectResult,
  HeadObjectResult,
} from "./s3/index.js";
export {
  AgentFSError,
  NotFoundError,
  PermissionDeniedError,
  EditConflictError,
  IndexingInProgressError,
  ValidationError,
} from "./errors.js";
export {
  dispatchOp,
  getRegisteredOps,
  getOpDefinition,
} from "./ops/index.js";
export type { OpContext, OpDefinition } from "./ops/index.js";
export {
  createUser,
  getUserByApiKey,
  getUserByEmail,
  createOrg,
  listUserOrgs,
  getOrg,
  inviteToOrg,
  createDrive,
  listDrives,
  getDrive,
  setDriveMember,
  checkPermission,
  getRequiredRole,
  getUserDriveRole,
  resolveContext,
} from "./identity/index.js";
export type { Role, ResolvedContext } from "./identity/index.js";
