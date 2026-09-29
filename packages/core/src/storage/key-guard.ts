import { ValidationError } from "../errors.js";

/**
 * Refuse a storage key that could leave the drive it was built for.
 *
 * Ops build a key as `<orgId>/drives/<driveId>/<path>` from the caller's own
 * org and drive plus a user-supplied path. The local-filesystem backend
 * resolves that key against the whole storage root, so a `..` in the path
 * climbs out of the drive into another tenant's (`/../../../<org>/drives/<drive>/x`).
 * Nothing else stands between two drives: they are sibling directories.
 *
 * Rejects a `.` or `..` segment on either separator (a backslash is a
 * separator on Windows hosts) and NUL bytes. With no dot segments the key
 * cannot resolve anywhere but where it reads, so it keeps the drive prefix it
 * was built with. Names that merely contain dots (`a.b`, `.env`, `..foo`,
 * `file..`) are fine.
 *
 * Only the local adapter calls this. On S3 a key is opaque data and
 * `a/../b` is a legal object name, so that adapter deliberately does not.
 */
export function assertKeyInsideDrive(key: string): void {
  if (key.includes("\u0000")) {
    throw new ValidationError("Path must not contain NUL bytes", { field: "path" });
  }
  for (const segment of key.split(/[\\/]/)) {
    if (segment === "." || segment === "..") {
      throw new ValidationError("Path must not contain '.' or '..' segments", {
        field: "path",
        suggestion: "Use the absolute path of the file inside the drive, e.g. /docs/report.pdf",
      });
    }
  }
}
