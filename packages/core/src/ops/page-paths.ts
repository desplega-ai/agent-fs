import { AgentFSError } from "../errors.js";

/**
 * Path and data rules of the page bridge (`window.agentfs`) for the server's
 * `/page/` shell. The live app's host keeps its own copy in
 * `live/src/lib/html-page-bridge.ts` (the browser build does not reach into
 * core); `live/src/lib/__tests__/page-paths-contract.test.ts` runs both over
 * the same cases, so a page gets the same answers from either host. Refusals
 * carry the bridge's `NOT_ALLOWED` code.
 */

const MAX_PATH = 512;
/** Largest file a page may read. */
export const PAGE_MAX_READ_BYTES = 1024 * 1024;
/** Largest content a page may write, in UTF-8 bytes. */
export const PAGE_MAX_WRITE_BYTES = 256 * 1024;
const DATA_EXTENSIONS: ReadonlySet<string> = new Set(["json", "txt", "md", "csv", "yaml", "yml", "ndjson"]);

export const pageNotAllowed = (message: string) => new AgentFSError("NOT_ALLOWED", message);

/**
 * The drive path of `relative` inside `folder` (`/a/b`, never `/`), or a
 * `NOT_ALLOWED` error. The path is taken literally: `%2e%2e` is a name, not `..`.
 */
export function resolvePagePath(folder: string, relative: string): string {
  if (relative.length === 0 || relative.length > MAX_PATH) throw pageNotAllowed(`Path must be 1 to ${MAX_PATH} characters`);
  if (relative.startsWith("/")) throw pageNotAllowed("Path must be relative to the page's folder");
  if (relative.includes("\\") || relative.includes("\0")) throw pageNotAllowed("Path must not contain a backslash or NUL");
  if (relative.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw pageNotAllowed("Path must not contain empty, '.' or '..' segments");
  }
  // With no leading slash and no empty, `.` or `..` segment, the joined path
  // is already normal and inside the folder on a segment boundary.
  return `${folder}/${relative}`;
}

/** Refuses a write that is not a data file under `<folder>/data/`. */
export function assertPageDataWrite(folder: string, path: string, content: string): void {
  if (!path.startsWith(`${folder}/data/`)) throw pageNotAllowed("Pages can only write under data/");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !DATA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) {
    throw pageNotAllowed(`Pages can only write ${[...DATA_EXTENSIONS].join(", ")} files`);
  }
  if (Buffer.byteLength(content, "utf8") > PAGE_MAX_WRITE_BYTES) throw pageNotAllowed("Content is larger than 256 KB");
}
