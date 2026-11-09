import { ValidationError } from "../errors.js";

/**
 * Refuse a storage key that could leave the drive it was built for.
 *
 * Ops build a key as `<orgId>/drives/<driveId>/<path>` from the caller's own
 * org and drive plus a user-supplied path. The local-filesystem backend
 * resolves that key against the whole storage root, so a `..` in the path
 * climbs out of the drive into another tenant's (`/../../../<org>/drives/<drive>/x`).
 * Nothing else stands between two drives: they are sibling directories. On
 * S3-compatible backends the key goes on the wire with its `..` segments, and
 * whether the provider resolves them is up to the provider.
 *
 * Rejects a `.` or `..` segment on either separator (a backslash is a
 * separator on Windows hosts) and NUL bytes. With no dot segments the key
 * cannot resolve anywhere but where it reads, so it keeps the drive prefix it
 * was built with. Names that merely contain dots (`a.b`, `.env`, `..foo`,
 * `file..`) are fine.
 *
 * Both storage adapters call this on every key and prefix they are given.
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
