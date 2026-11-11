import type { Context } from "hono";
import {
  AgentFSError,
  NotFoundError,
  PermissionDeniedError,
  EditConflictError,
  IndexingInProgressError,
  ValidationError,
  UnsupportedOperation,
  EmbeddingProviderError,
  PresenceLimitError,
} from "@/core";
import { redactShareToken } from "./request-log.js";

function getStatusCode(err: Error): number {
  if (err instanceof NotFoundError) return 404;
  if (err instanceof PermissionDeniedError) return 403;
  if (err instanceof EditConflictError) return 409;
  if (err instanceof IndexingInProgressError) return 503;
  if (err instanceof ValidationError) return 400;
  // 422 Unprocessable: the request was well-formed but the active storage
  // backend can't satisfy it. Distinct from the generic 400 so clients don't
  // treat an unsupported-backend op as a malformed request / server bug.
  if (err instanceof UnsupportedOperation) return 422;
  // 502 Bad Gateway: the upstream embedding provider sent an unusable vector.
  if (err instanceof EmbeddingProviderError) return 502;
  if (err instanceof PresenceLimitError) return 429;
  if (err instanceof AgentFSError) return 400;
  return 500;
}

export function handleError(err: Error, c: Context) {
  if (err instanceof AgentFSError) {
    return c.json(err.toJSON(), getStatusCode(err) as any);
  }

  // Never echo unexpected errors: storage and database messages carry bucket
  // names, endpoints and SQL. The detail goes to the server log only.
  console.error(`unhandled error on ${c.req.method} ${redactShareToken(c.req.path)}:`, err);
  return c.json({ error: "INTERNAL_ERROR", message: "Internal server error" }, 500);
}
