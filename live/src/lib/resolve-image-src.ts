/**
 * Classifies a markdown image `src` so the viewer knows whether to render it
 * as-is (`external`) or mint a signed URL for it (`drive`).
 *
 * A plain `<img src>` cannot carry the `Authorization` header the daemon
 * requires, so any reference that points at a file inside an agent-fs drive
 * — by live-host viewer URL, drive-absolute path, or path relative to the
 * markdown document — must resolve to a signed URL instead of the raw path.
 */

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
const DRIVE_VIEWER_PATH = new RegExp(`^/file/~/(${UUID})/(${UUID})/(.+)$`)
/** The same viewer address by org and drive name. The names are still encoded. */
const DRIVE_VIEWER_NAME_PATH = /^\/file\/((?!~\/)[^/]+)\/([^/]+)\/(.+)$/

export type ImageSrcResolution =
  | { kind: "external"; url: string }
  | { kind: "drive"; orgId: string; driveId: string; path: string }
  /** A viewer address by name; the caller resolves the names to a drive. */
  | { kind: "drive-name"; orgName: string; driveName: string; path: string }

/**
 * @param src Raw `src` attribute from the parsed markdown image node.
 * @param docPath Path of the markdown document itself, inside its drive.
 * @param routeOrgId Org of the document currently open (from the route).
 * @param routeDriveId Drive of the document currently open (from the route).
 * @param currentOrigin Origin the viewer is currently served from. Defaults
 *   to `window.location.origin` in the browser; callers in tests pass it
 *   explicitly since there is no `window` there.
 */
export function resolveImageSrc(
  src: string,
  docPath: string,
  routeOrgId: string,
  routeDriveId: string,
  currentOrigin: string = typeof window !== "undefined" ? window.location.origin : "",
): ImageSrcResolution {
  const url = tryParseAbsoluteUrl(src)
  if (url) {
    if (isTrustedViewerOrigin(url, currentOrigin)) {
      const match = DRIVE_VIEWER_PATH.exec(url.pathname)
      if (match) {
        return {
          kind: "drive",
          orgId: match[1],
          driveId: match[2],
          path: safeDecodeURIComponent(match[3]),
        }
      }
      const named = DRIVE_VIEWER_NAME_PATH.exec(url.pathname)
      if (named) {
        return {
          kind: "drive-name",
          orgName: safeDecodeURIComponent(named[1]),
          driveName: safeDecodeURIComponent(named[2]),
          path: safeDecodeURIComponent(named[3]),
        }
      }
    }
    return { kind: "external", url: src }
  }

  if (src.startsWith("/")) {
    return {
      kind: "drive",
      orgId: routeOrgId,
      driveId: routeDriveId,
      path: safeDecodeURIComponent(stripQueryAndHash(src.slice(1))),
    }
  }

  return {
    kind: "drive",
    orgId: routeOrgId,
    driveId: routeDriveId,
    path: resolveRelativePath(docPath, safeDecodeURIComponent(stripQueryAndHash(src))),
  }
}

function tryParseAbsoluteUrl(src: string): URL | null {
  try {
    return new URL(src)
  } catch {
    return null
  }
}

/**
 * A `/file/~/<org>/<drive>/...` pathname only identifies an agent-fs drive
 * reference when it comes from an origin we trust — otherwise an external
 * host (e.g. a public CDN) that merely happens to share that path shape
 * would be misread as a drive reference. Trusts the viewer's own origin
 * (covers prod, previews, and self-hosted deployments alike) plus
 * `localhost`/`127.0.0.1` on any port, to keep local development working.
 */
function isTrustedViewerOrigin(url: URL, currentOrigin: string): boolean {
  if (currentOrigin && url.origin === currentOrigin) return true
  return url.hostname === "localhost" || url.hostname === "127.0.0.1"
}

/** A malformed percent escape (e.g. `%zz`) must not crash rendering — fall back to the raw segment. */
function safeDecodeURIComponent(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Strips a trailing `?query` and/or `#hash` from a path-only (non-URL) string. */
function stripQueryAndHash(path: string): string {
  const withoutHash = path.split("#")[0]
  return withoutHash.split("?")[0]
}

/** Resolves `relative` against the directory of `docPath`, clamped at the drive root. */
function resolveRelativePath(docPath: string, relative: string): string {
  const docDir = docPath.split("/").slice(0, -1)
  const segments = [...docDir, ...relative.split("/")]
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join("/")
}
