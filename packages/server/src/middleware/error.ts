import type { Context } from "hono";
import {
  NotFoundError,
  PermissionDeniedError,
  EditConflictError,
  IndexingInProgressError,
  ValidationError,
  UnsupportedOperation,
} from "@/core";

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
  if ("code" in err) return 400; // AgentFSError base
  return 500;
}

export function handleError(err: Error, c: Context) {
  const status = getStatusCode(err);

  // Check if error has toJSON (AgentFSError)
  if ("toJSON" in err && typeof (err as any).toJSON === "function") {
    return c.json((err as any).toJSON(), status as any);
  }

  return c.json(
    { error: "INTERNAL_ERROR", message: err.message },
    status as any
  );
}
