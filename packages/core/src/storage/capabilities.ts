import type { StorageAdapter, StorageCapabilities } from "./adapter.js";
import { UnsupportedOperation } from "../errors.js";

/**
 * Throw a typed `UnsupportedOperation` when the active storage backend cannot
 * satisfy an optional capability, instead of letting the op fail later with a
 * raw/confusing S3/FS error.
 *
 * Ops that depend on an optional capability (e.g. object versioning powering
 * `revert`) call this at their entry point so a limited backend fails cleanly
 * and the error surfaces with a friendly message + suggestion through the
 * daemon's HTTP error layer → CLI and → MCP.
 *
 * @param adapter   the backend to inspect (`ctx.s3`)
 * @param cap       which capability the op requires
 * @param operation human-facing op name used in the error message (e.g. "revert")
 * @param backend   optional backend label; omit to get a generic message
 */
export function assertCapability(
  adapter: StorageAdapter,
  cap: keyof StorageCapabilities,
  operation: string,
  backend?: string,
): void {
  if (!adapter.capabilities[cap]) {
    throw new UnsupportedOperation(operation, backend);
  }
}
