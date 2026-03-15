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
