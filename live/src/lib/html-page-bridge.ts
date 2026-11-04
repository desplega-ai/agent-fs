/**
 * The host side of `window.agentfs` (the server's `html-page-bridge.ts`). The
 * page asks once with `hello`; the host answers with a `MessagePort` bound to
 * that document and serves `identity`, `read`, `stat` and `write` on it with
 * the member's key. The page never names its own folder or holds a
 * credential: the folder comes from the route, paths are relative to it, and
 * writes reach only data files under `<folder>/data/` with the member's
 * consent. RBAC and version conflicts stay the server's.
 */
import type { CatResult, StatResult, WriteResult } from "@/api/types"

const PREFIX = "agent-fs-page:"
const MAX_PATH = 512
/** Largest file `read` returns. */
export const MAX_READ_BYTES = 1024 * 1024
/** Largest content `write` sends, in UTF-8 bytes. */
export const MAX_WRITE_BYTES = 256 * 1024
const MAX_MESSAGE = 1000
const MAX_IN_FLIGHT = 16
const MAX_MESSAGE_BYTES = 1024 * 1024
const READ_RETRIES = 3
const DATA_EXTENSIONS = new Set(["json", "txt", "md", "csv", "yaml", "yml", "ndjson"])

/** localStorage key of the folders whose pages may know the member and save data. */
export const PAGE_ACCESS_KEY = "liveui:page-access"

export interface Viewer { name: string; email: string; kind: "member" | "guest" }

export class PageBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const refuse = (message: string) => new PageBridgeError("NOT_ALLOWED", message)

function messageBytes(data: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(data)).length
  } catch {
    return Infinity
  }
}

/** The nonce of the page's `{ type: "agent-fs-page:hello", v: 1, nonce }`, or null for anything else. */
export function parsePageHello(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const d = data as Record<string, unknown>
  return d.type === `${PREFIX}hello` && d.v === 1 && typeof d.nonce === "string" && /^[0-9a-f]{32}$/.test(d.nonce) ? d.nonce : null
}

export type PageRequest =
  | { id: number; op: "identity" }
  | { id: number; op: "read"; path: string }
  | { id: number; op: "stat"; path: string }
  | { id: number; op: "write"; path: string; content: string; expectedVersion: number; message?: string }

/**
 * A request on the port. `null` when it has no usable id (nothing to answer);
 * a `PageBridgeError` with that id when a field is wrong.
 */
export function parsePageRequest(data: unknown): PageRequest | { id: number; error: PageBridgeError } | null {
  if (!data || typeof data !== "object") return null
  const d = data as Record<string, unknown>
  const id = d.id
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null
  const bad = (message: string) => ({ id, error: new PageBridgeError("VALIDATION_ERROR", message) })
  switch (d.op) {
    case "identity":
      return { id, op: "identity" }
    case "read":
      return typeof d.path === "string" ? { id, op: "read", path: d.path } : bad("path must be a string")
    case "stat":
      return typeof d.path === "string" ? { id, op: "stat", path: d.path } : bad("path must be a string")
    case "write":
      if (typeof d.path !== "string") return bad("path must be a string")
      if (typeof d.content !== "string") return bad("content must be a string")
      if (typeof d.expectedVersion !== "number" || !Number.isSafeInteger(d.expectedVersion) || d.expectedVersion < 0) {
        return bad("expectedVersion is required: the version you read, or 0 to create")
      }
      if (d.message !== undefined && (typeof d.message !== "string" || d.message.length > MAX_MESSAGE)) {
        return bad(`message must be a string of at most ${MAX_MESSAGE} characters`)
      }
      return { id, op: "write", path: d.path, content: d.content, expectedVersion: d.expectedVersion, message: d.message as string | undefined }
    default:
      return bad("Unknown op")
  }
}

/**
 * The drive path of `relative` inside `folder` (`/a/b`, never `/`), or a
 * `NOT_ALLOWED` error. The path is taken literally: `%2e%2e` is a name, not `..`.
 */
export function resolvePagePath(folder: string, relative: string): string {
  if (relative.length === 0 || relative.length > MAX_PATH) throw refuse(`Path must be 1 to ${MAX_PATH} characters`)
  if (relative.startsWith("/")) throw refuse("Path must be relative to the page's folder")
  if (relative.includes("\\") || relative.includes("\0")) throw refuse("Path must not contain a backslash or NUL")
  if (relative.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw refuse("Path must not contain empty, '.' or '..' segments")
  }
  // With no leading slash and no empty, `.` or `..` segment, the joined path
  // is already normal and inside the folder on a segment boundary.
  return `${folder}/${relative}`
}

/** Refuses a write that is not a data file under `<folder>/data/`. */
export function assertDataWrite(folder: string, path: string, content: string): void {
  if (!path.startsWith(`${folder}/data/`)) throw refuse("Pages can only write under data/")
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || !DATA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) {
    throw refuse(`Pages can only write ${[...DATA_EXTENSIONS].join(", ")} files`)
  }
  if (new TextEncoder().encode(content).length > MAX_WRITE_BYTES) throw refuse("Content is larger than 256 KB")
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">

export interface ConsentScope { endpoint: string; userId: string; orgId: string; driveId: string; folder: string }

export function pageAccessKey(s: ConsentScope): string {
  return JSON.stringify([s.endpoint.replace(/\/+$/, ""), s.userId, s.orgId, s.driveId, s.folder])
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function readAccess(storage: KeyValueStorage | null): Record<string, true> {
  try {
    const parsed = JSON.parse(storage?.getItem(PAGE_ACCESS_KEY) ?? "null")
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeAccess(storage: KeyValueStorage | null, value: Record<string, true>): void {
  try {
    storage?.setItem(PAGE_ACCESS_KEY, JSON.stringify(value))
  } catch {
    // ignore quota / privacy errors: access then lasts this page view only
  }
}

export function hasPageAccess(scope: ConsentScope, storage = defaultStorage()): boolean {
  return readAccess(storage)[pageAccessKey(scope)] === true
}

export function setPageAccess(scope: ConsentScope, allowed: boolean, storage = defaultStorage()): void {
  const access = readAccess(storage)
  if (allowed) access[pageAccessKey(scope)] = true
  else delete access[pageAccessKey(scope)]
  writeAccess(storage, access)
}

/** What the bridge needs from the app. */
export interface PageHost {
  /** The page's folder (`/a/b`), or null at the drive root, where pages get no access. */
  folder: string | null
  callOp<T>(op: string, params: Record<string, unknown>): Promise<T>
  /** The viewer once the member allows this folder (asking if needed), else null. */
  requestIdentity(): Promise<Viewer | null>
  /** Whether the member allowed this folder. */
  allowed(): boolean
}

/**
 * The host for a signed-in member. Consent is read from storage on every
 * identity and write request, so a revoke in another view or tab applies to
 * the next one. `scope` is null until the member is known; `ask` shows the
 * consent banner and resolves true for "Allow".
 */
export function memberPageHost(opts: {
  folder: string | null
  scope: () => ConsentScope | null
  viewer: () => Viewer | null
  callOp: PageHost["callOp"]
  ask: () => Promise<boolean>
  storage?: KeyValueStorage | null
}): PageHost {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage
  const allowed = () => {
    const scope = opts.scope()
    return !!scope && hasPageAccess(scope, storage)
  }
  return {
    folder: opts.folder,
    callOp: opts.callOp,
    allowed,
    async requestIdentity() {
      const scope = opts.scope()
      if (!scope) return null
      if (!allowed()) {
        if (!(await opts.ask())) return null
        setPageAccess(scope, true, storage)
      }
      return opts.viewer()
    },
  }
}

function apiError(err: unknown): PageBridgeError {
  if (err instanceof PageBridgeError) return err
  const e = err as { error?: unknown; message?: unknown } | null
  return new PageBridgeError(typeof e?.error === "string" ? e.error : "UNKNOWN", typeof e?.message === "string" ? e.message : "Request failed")
}

async function statOrNull(host: PageHost, path: string): Promise<StatResult | null> {
  try {
    return await host.callOp<StatResult>("stat", { path })
  } catch (err) {
    if (apiError(err).code === "NOT_FOUND") return null
    throw err
  }
}

/**
 * A complete read and the version of those bytes: `cat` and the `stat` after
 * it must name the same object, or the file changed in between and we retry.
 */
async function readFile(host: PageHost, path: string): Promise<{ content: string; version: number | null }> {
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    const before = await statOrNull(host, path)
    if (!before) throw new PageBridgeError("NOT_FOUND", `File not found: ${path}`)
    if (before.size > MAX_READ_BYTES) throw refuse("File is larger than 1 MB")
    // A line is at least one byte, so this limit covers any file under the cap.
    const got = await host.callOp<CatResult>("cat", { path, limit: MAX_READ_BYTES + 1 })
    if (got.truncated) throw refuse("File is larger than 1 MB")
    const after = await statOrNull(host, path)
    if (!after || !got.etag || after.etag !== got.etag) continue
    // The file may have grown into one long line between the first stat and cat.
    if (after.size > MAX_READ_BYTES || new TextEncoder().encode(got.content).length > MAX_READ_BYTES) {
      throw refuse("File is larger than 1 MB")
    }
    return { content: got.content, version: after.currentVersion ?? null }
  }
  throw new PageBridgeError("CONFLICT", "The file kept changing while it was read")
}

/** Serves one request. Throws a `PageBridgeError` the page sees as `{ code, message }`. */
export async function handlePageRequest(host: PageHost, req: PageRequest): Promise<unknown> {
  const { folder } = host
  if (req.op === "identity") return folder ? host.requestIdentity() : null
  if (!folder) throw refuse("Pages at the drive root have no access")
  try {
    const path = resolvePagePath(folder, req.path)
    if (req.op === "stat") {
      const s = await statOrNull(host, path)
      return s && { version: s.currentVersion ?? null, size: s.size, modifiedAt: s.modifiedAt }
    }
    if (req.op === "read") return await readFile(host, path)
    assertDataWrite(folder, path, req.content)
    if (!host.allowed()) throw refuse("The viewer has not allowed this page to save data")
    const written = await host.callOp<WriteResult>("write", {
      path,
      content: req.content,
      expectedVersion: req.expectedVersion,
      ...(req.message !== undefined ? { message: req.message } : {}),
    })
    return { version: written.version }
  } catch (err) {
    throw apiError(err)
  }
}

export interface HtmlPageBridge {
  dispose(): void
}

type MessageTarget = Pick<Window, "addEventListener" | "removeEventListener">

/**
 * Hand the page in `frame` a port. Hellos are answered only before the frame's
 * first `load`, and only once, so only the frame's first document can get a
 * port; a new page gets a new frame element and a new bridge. The page's first
 * message on the port must ack the nonce of its hello, or the port closes for
 * good. The port also closes when the page says bye, on any later `load` (the
 * frame navigated) and on dispose; replies still running are then dropped.
 * `onClose` runs when the port closes.
 */
export function createHtmlPageBridge(
  frame: Pick<HTMLIFrameElement, "contentWindow" | "addEventListener" | "removeEventListener">,
  host: PageHost,
  onClose: () => void = () => {},
  win: MessageTarget = window,
): HtmlPageBridge {
  let port: MessagePort | null = null
  let answered = false
  let loaded = false

  const close = () => {
    if (!port) return
    port.onmessage = null
    port.close()
    port = null
    onClose()
  }

  const serve = (own: MessagePort, nonce: string) => {
    let acked = false
    let inFlight = 0
    return (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (!acked) {
        if (data?.type === `${PREFIX}ack` && data.nonce === nonce) acked = true
        else close()
        return
      }
      if (data?.type === `${PREFIX}bye`) return close()
      const req = parsePageRequest(data)
      if (!req) return
      const reply = (msg: Record<string, unknown>) => {
        if (port === own) own.postMessage({ id: req.id, ...msg })
      }
      const fail = (err: unknown) => {
        const e = apiError(err)
        reply({ error: { code: e.code, message: e.message } })
      }
      if (inFlight >= MAX_IN_FLIGHT) return fail(refuse(`At most ${MAX_IN_FLIGHT} requests in flight`))
      if (messageBytes(data) > MAX_MESSAGE_BYTES) return fail(refuse("Request is larger than 1 MB"))
      if ("error" in req) return fail(req.error)
      inFlight++
      handlePageRequest(host, req)
        .then((result) => reply({ result }), fail)
        .finally(() => inFlight--)
    }
  }

  const listener = (event: Event) => {
    const e = event as MessageEvent
    if (!frame.contentWindow || e.source !== frame.contentWindow) return
    const nonce = parsePageHello(e.data)
    if (!nonce || answered || loaded) return
    answered = true
    const channel = new MessageChannel()
    port = channel.port1
    port.onmessage = serve(channel.port1, nonce)
    frame.contentWindow.postMessage({ type: `${PREFIX}host`, v: 1 }, "*", [channel.port2])
  }

  const onLoad = () => {
    if (loaded) close()
    loaded = true
  }

  win.addEventListener("message", listener)
  frame.addEventListener("load", onLoad)
  return {
    dispose() {
      win.removeEventListener("message", listener)
      frame.removeEventListener("load", onLoad)
      close()
    },
  }
}
