/**
 * Centralized path normalization for agentfs.
 *
 * Two conventions:
 *   - File paths: always start with `/`, no trailing `/`
 *   - Directory prefixes: always start with `/`, always end with `/`
 *   - S3 keys: no leading `/` (stripped by getS3Key)
 */

/** Ensure a file path starts with `/` and has no trailing `/`. */
export function normalizePath(path: string): string {
  let p = path;
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Ensure a directory prefix starts with `/` and ends with `/`. */
export function normalizePrefix(path: string): string {
  let p = path;
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.endsWith("/")) p += "/";
  return p;
}

/** Strip leading `/` for S3 key construction. */
export function stripLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}
