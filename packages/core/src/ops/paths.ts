import { ValidationError } from "../errors.js";

/**
 * Centralized path normalization for agent-fs.
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

/**
 * Refuse a path that could leave the caller's drive.
 *
 * A drive is `<orgId>/drives/<driveId>/` inside one storage namespace, and the
 * local-filesystem backend resolves a key against the whole storage root, so
 * `/../../../<org>/drives/<drive>/x` reaches another tenant's drive. S3 treats
 * `..` as a literal character, but a path that means two different things on
 * two backends is not one to hand out a public link for.
 *
 * Rejects a `.` or `..` segment on either separator (a backslash is a
 * separator on Windows hosts) and NUL bytes. Names that merely contain dots
 * (`a..b`, `.hidden`, `file..`) are fine. This is deliberately not folded into
 * {@link normalizePath}: most ops build their key straight from the raw path
 * and never call it, and on S3 an existing `a/../b` key is legal data.
 */
export function assertPathInsideDrive(path: string): void {
  if (path.includes("\u0000")) {
    throw new ValidationError("Path must not contain NUL bytes", { field: "path" });
  }
  for (const segment of path.split(/[\\/]/)) {
    if (segment === "." || segment === "..") {
      throw new ValidationError("Path must not contain '.' or '..' segments", {
        field: "path",
        suggestion: "Use the absolute path of the file inside the drive, e.g. /docs/report.pdf",
      });
    }
  }
}
