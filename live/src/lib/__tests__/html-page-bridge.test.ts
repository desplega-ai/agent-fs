import { describe, expect, test } from "bun:test"
import {
  MAX_WRITE_BYTES,
  PAGE_ACCESS_KEY,
  PageBridgeError,
  assertDataWrite,
  createHtmlPageBridge,
  handlePageRequest,
  hasPageAccess,
  memberPageHost,
  parsePageHello,
  pageAccessKey,
  parsePageRequest,
  resolvePagePath,
  setPageAccess,
  type PageHost,
  type PageRequest,
  type Viewer,
} from "../html-page-bridge"

const P = "agent-fs-page:"
const FOLDER = "/work/foo"

function code(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (err) {
    return (err as PageBridgeError).code
  }
}

async function rejection(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
  } catch (err) {
    return err as PageBridgeError
  }
  throw new Error("expected a rejection")
}

const NONCE = "0123456789abcdef0123456789abcdef"

describe("parsePageHello", () => {
  test("accepts only the exact hello, and returns its nonce", () => {
    expect(parsePageHello({ type: `${P}hello`, v: 1, nonce: NONCE })).toBe(NONCE)
    for (const bad of [null, undefined, "x", 1, [], {}, { type: `${P}hello`, v: 1 }, { type: `${P}hello`, v: 2, nonce: NONCE },
      { type: `${P}hello`, v: "1", nonce: NONCE }, { type: `${P}hello`, v: 1, nonce: "short" }, { type: `${P}hello`, v: 1, nonce: NONCE.toUpperCase() },
      { type: `${P}hello`, v: 1, nonce: 5 }, { type: "agent-fs-comments:hello", v: 1, nonce: NONCE }, { type: `${P}host`, v: 1, nonce: NONCE }]) {
      expect(parsePageHello(bad)).toBeNull()
    }
  })
})

describe("parsePageRequest", () => {
  test("accepts each well-formed request", () => {
    expect(parsePageRequest({ id: 1, op: "identity" })).toEqual({ id: 1, op: "identity" })
    expect(parsePageRequest({ id: 2, op: "read", path: "a.json" })).toEqual({ id: 2, op: "read", path: "a.json" })
    expect(parsePageRequest({ id: 3, op: "stat", path: "a.json" })).toEqual({ id: 3, op: "stat", path: "a.json" })
    expect(parsePageRequest({ id: 4, op: "write", path: "data/a.json", content: "{}", expectedVersion: 0, message: "m" }))
      .toEqual({ id: 4, op: "write", path: "data/a.json", content: "{}", expectedVersion: 0, message: "m" })
  })

  test("ignores a message without a usable id", () => {
    for (const bad of [null, "x", 7, [], {}, { op: "identity" }, { id: "1", op: "identity" }, { id: 0, op: "identity" },
      { id: -1, op: "identity" }, { id: 1.5, op: "identity" }, { id: Number.MAX_SAFE_INTEGER + 1, op: "identity" }]) {
      expect(parsePageRequest(bad)).toBeNull()
    }
  })

  test("answers a malformed request with VALIDATION_ERROR", () => {
    const bad = [
      { id: 1, op: "rm", path: "a" },
      { id: 1 },
      { id: 1, op: "read" },
      { id: 1, op: "stat", path: 5 },
      { id: 1, op: "write", path: "data/a.json", content: 5, expectedVersion: 0 },
      { id: 1, op: "write", path: "data/a.json", content: "{}" },
      { id: 1, op: "write", path: "data/a.json", content: "{}", expectedVersion: -1 },
      { id: 1, op: "write", path: "data/a.json", content: "{}", expectedVersion: 1.5 },
      { id: 1, op: "write", path: "data/a.json", content: "{}", expectedVersion: "1" },
      { id: 1, op: "write", path: "data/a.json", content: "{}", expectedVersion: 1, message: 3 },
      { id: 1, op: "write", path: "data/a.json", content: "{}", expectedVersion: 1, message: "x".repeat(1001) },
    ]
    for (const data of bad) {
      const parsed = parsePageRequest(data) as { id: number; error: PageBridgeError }
      expect(parsed.id).toBe(1)
      expect(parsed.error.code).toBe("VALIDATION_ERROR")
    }
  })
})

describe("resolvePagePath", () => {
  test("joins a relative path to the folder", () => {
    expect(resolvePagePath(FOLDER, "data/state.json")).toBe("/work/foo/data/state.json")
    expect(resolvePagePath(FOLDER, "notes.md")).toBe("/work/foo/notes.md")
    expect(resolvePagePath(FOLDER, "données/été 🎉.json")).toBe("/work/foo/données/été 🎉.json")
    expect(resolvePagePath(FOLDER, "a..b/.hidden")).toBe("/work/foo/a..b/.hidden")
  })

  test("leaves percent sequences alone", () => {
    expect(resolvePagePath(FOLDER, "%2e%2e/x.json")).toBe("/work/foo/%2e%2e/x.json")
    expect(resolvePagePath(FOLDER, "a%2Fb.json")).toBe("/work/foo/a%2Fb.json")
  })

  test("refuses anything that could leave the folder or is not plain", () => {
    for (const bad of ["", "/etc/passwd", "/work/foo/a.json", "..", "../foo-bar/a.json", "a/../../x", "./a.json", "a/./b",
      "a//b", "a/", "a\\b", "..\\x", "a\0b", "x".repeat(513)]) {
      expect(code(() => resolvePagePath(FOLDER, bad))).toBe("NOT_ALLOWED")
    }
    expect(resolvePagePath(FOLDER, "x".repeat(512))).toStartWith(`${FOLDER}/`)
  })

  test("a sibling folder that shares a prefix is outside", () => {
    expect(code(() => resolvePagePath(FOLDER, "../foo-bar/data/a.json"))).toBe("NOT_ALLOWED")
    expect(resolvePagePath(FOLDER, "foo-bar")).toBe("/work/foo/foo-bar")
  })
})

describe("assertDataWrite", () => {
  test("allows data files under data/", () => {
    for (const ext of ["json", "txt", "md", "csv", "yaml", "yml", "ndjson", "JSON"]) {
      expect(code(() => assertDataWrite(FOLDER, `${FOLDER}/data/sub/a.${ext}`, "x"))).toBeNull()
    }
  })

  test("refuses other folders and extensions", () => {
    for (const path of [`${FOLDER}/a.json`, `${FOLDER}/database/a.json`, `${FOLDER}/data`, `${FOLDER}/sub/data/a.json`,
      `${FOLDER}/data/index.html`, `${FOLDER}/data/app.js`, `${FOLDER}/data/a.svg`, `${FOLDER}/data/json`, `${FOLDER}/data/.json`]) {
      expect(code(() => assertDataWrite(FOLDER, path, "x"))).toBe("NOT_ALLOWED")
    }
  })

  test("caps content at 256 KB of UTF-8", () => {
    expect(code(() => assertDataWrite(FOLDER, `${FOLDER}/data/a.txt`, "x".repeat(MAX_WRITE_BYTES)))).toBeNull()
    expect(code(() => assertDataWrite(FOLDER, `${FOLDER}/data/a.txt`, "x".repeat(MAX_WRITE_BYTES + 1)))).toBe("NOT_ALLOWED")
    // 2 bytes each: under the cap in characters, over it in bytes.
    expect(code(() => assertDataWrite(FOLDER, `${FOLDER}/data/a.txt`, "é".repeat(MAX_WRITE_BYTES / 2 + 1)))).toBe("NOT_ALLOWED")
  })
})

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

describe("consent", () => {
  const scope = { endpoint: "https://api.test/", userId: "u1", orgId: "o", driveId: "d", folder: FOLDER }

  test("is remembered per endpoint, user, org, drive and folder, and revoked", () => {
    const storage = memoryStorage()
    expect(hasPageAccess(scope, storage)).toBe(false)
    setPageAccess(scope, true, storage)
    expect(hasPageAccess(scope, storage)).toBe(true)
    expect(hasPageAccess({ ...scope, endpoint: "https://api.test" }, storage)).toBe(true)
    for (const other of [{ endpoint: "https://other.test" }, { userId: "u2" }, { orgId: "o2" }, { driveId: "d2" }, { folder: "/work" }, { folder: "/work/foo/sub" }]) {
      expect(hasPageAccess({ ...scope, ...other }, storage)).toBe(false)
    }
    expect(Object.keys(JSON.parse(storage.data.get(PAGE_ACCESS_KEY)!))).toEqual([pageAccessKey(scope)])
    setPageAccess(scope, false, storage)
    expect(hasPageAccess(scope, storage)).toBe(false)
  })

  test("a corrupt entry reads as no access", () => {
    const storage = memoryStorage()
    storage.setItem(PAGE_ACCESS_KEY, "{not json")
    expect(hasPageAccess(scope, storage)).toBe(false)
    storage.setItem(PAGE_ACCESS_KEY, JSON.stringify([pageAccessKey(scope)]))
    expect(hasPageAccess(scope, storage)).toBe(false)
  })
})

const VIEWER: Viewer = { name: "Ada", email: "ada@example.test", kind: "member" }

interface Calls { op: string; params: Record<string, unknown> }

function fakeHost(over: Partial<PageHost> = {}, answer: (c: Calls) => unknown = () => ({})) {
  const calls: Calls[] = []
  let allowed = true
  const host: PageHost = {
    folder: FOLDER,
    callOp: async <T,>(op: string, params: Record<string, unknown>) => {
      calls.push({ op, params })
      return answer({ op, params }) as T
    },
    requestIdentity: async () => (allowed ? VIEWER : null),
    allowed: () => allowed,
    ...over,
  }
  return { host, calls, setAllowed: (v: boolean) => { allowed = v } }
}

const notFound = () => Object.assign(new Error("File not found"), { error: "NOT_FOUND" })
const stat = (etag: string, version = 3, size = 10) => ({ path: "x", size, currentVersion: version, modifiedAt: "2026-11-04T00:00:00Z", etag })

describe("handlePageRequest", () => {
  const req = (r: Omit<PageRequest, "id">) => ({ id: 1, ...r }) as PageRequest

  test("identity asks the host; the root gets null without asking", async () => {
    expect(await handlePageRequest(fakeHost().host, req({ op: "identity" }))).toEqual(VIEWER)
    let asked = false
    const root = fakeHost({ folder: null, requestIdentity: async () => { asked = true; return VIEWER } }).host
    expect(await handlePageRequest(root, req({ op: "identity" }))).toBeNull()
    expect(asked).toBe(false)
  })

  test("the root refuses read, stat and write", async () => {
    const { host, calls } = fakeHost({ folder: null })
    for (const r of [{ op: "read", path: "a.json" }, { op: "stat", path: "a.json" }, { op: "write", path: "data/a.json", content: "", expectedVersion: 0 }]) {
      expect((await rejection(handlePageRequest(host, req(r as Omit<PageRequest, "id">)))).code).toBe("NOT_ALLOWED")
    }
    expect(calls).toEqual([])
  })

  test("stat maps the version and is null for a missing file", async () => {
    const { host, calls } = fakeHost({}, ({ params }) => {
      if (params.path === `${FOLDER}/missing.json`) throw notFound()
      return stat("e1")
    })
    expect(await handlePageRequest(host, req({ op: "stat", path: "a.json" }))).toEqual({ version: 3, size: 10, modifiedAt: "2026-11-04T00:00:00Z" })
    expect(await handlePageRequest(host, req({ op: "stat", path: "missing.json" }))).toBeNull()
    expect(calls[0]).toEqual({ op: "stat", params: { path: `${FOLDER}/a.json` } })
  })

  test("read pairs the bytes with the version whose etag they have", async () => {
    const { host, calls } = fakeHost({}, ({ op }) => op === "cat" ? { content: "a\n", totalLines: 2, truncated: false, etag: "e1" } : stat("e1", 7))
    expect(await handlePageRequest(host, req({ op: "read", path: "a.json" }))).toEqual({ content: "a\n", version: 7 })
    expect(calls.map((c) => c.op)).toEqual(["stat", "cat", "stat"])
    expect(calls[1].params).toEqual({ path: `${FOLDER}/a.json`, limit: 1024 * 1024 + 1 })
  })

  test("read retries while the file changes between cat and stat, then fails with CONFLICT", async () => {
    let n = 0
    const changing = fakeHost({}, ({ op }) => op === "cat" ? { content: "x", totalLines: 1, truncated: false, etag: `c${++n}` } : stat(`s${n}`))
    expect((await rejection(handlePageRequest(changing.host, req({ op: "read", path: "a.json" }))))).toMatchObject({ code: "CONFLICT" })
    expect(changing.calls.filter((c) => c.op === "cat")).toHaveLength(4)

    let m = 0
    const settles = fakeHost({}, ({ op }) => {
      if (op === "cat") return { content: `v${++m}`, totalLines: 1, truncated: false, etag: `e${m}` }
      return stat(m >= 2 ? "e2" : "e0", m >= 2 ? 9 : 8)
    })
    expect(await handlePageRequest(settles.host, req({ op: "read", path: "a.json" }))).toEqual({ content: "v2", version: 9 })
  })

  test("read refuses big or truncated files and reports a missing one", async () => {
    const big = fakeHost({}, () => stat("e", 1, 1024 * 1024 + 1))
    expect((await rejection(handlePageRequest(big.host, req({ op: "read", path: "a.json" })))).code).toBe("NOT_ALLOWED")
    expect(big.calls.map((c) => c.op)).toEqual(["stat"])
    const truncated = fakeHost({}, ({ op }) => op === "cat" ? { content: "", totalLines: 9, truncated: true, etag: "e" } : stat("e"))
    expect((await rejection(handlePageRequest(truncated.host, req({ op: "read", path: "a.json" })))).code).toBe("NOT_ALLOWED")
    const missing = fakeHost({}, () => { throw notFound() })
    expect((await rejection(handlePageRequest(missing.host, req({ op: "read", path: "a.json" })))).code).toBe("NOT_FOUND")
  })

  test("read refuses a file that grew past 1 MB as one line between the first stat and cat", async () => {
    let stats = 0
    const big = "x".repeat(1024 * 1024 + 1)
    const grew = fakeHost({}, ({ op }) => op === "cat"
      ? { content: big, totalLines: 1, truncated: false, etag: "e2" }
      : ++stats === 1 ? stat("e1", 1, 10) : stat("e2", 2, big.length))
    expect((await rejection(handlePageRequest(grew.host, req({ op: "read", path: "a.json" })))).code).toBe("NOT_ALLOWED")
    // Even when stat still reports a small size, the bytes returned are checked.
    const lying = fakeHost({}, ({ op }) => op === "cat" ? { content: big, totalLines: 1, truncated: false, etag: "e" } : stat("e", 1, 10))
    expect((await rejection(handlePageRequest(lying.host, req({ op: "read", path: "a.json" })))).code).toBe("NOT_ALLOWED")
  })

  test("write sends expectedVersion and message, and passes the server's errors through", async () => {
    const { host, calls } = fakeHost({}, () => ({ version: 4, path: "x", size: 2 }))
    expect(await handlePageRequest(host, req({ op: "write", path: "data/a.json", content: "{}", expectedVersion: 3, message: "Done: task 1" })))
      .toEqual({ version: 4 })
    expect(calls).toEqual([{ op: "write", params: { path: `${FOLDER}/data/a.json`, content: "{}", expectedVersion: 3, message: "Done: task 1" } }])

    for (const server of ["EDIT_CONFLICT", "PERMISSION_DENIED", "VALIDATION_ERROR"]) {
      const failing = fakeHost({}, () => { throw Object.assign(new Error(`server says ${server}`), { error: server }) })
      expect(await rejection(handlePageRequest(failing.host, req({ op: "write", path: "data/a.json", content: "{}", expectedVersion: 0 }))))
        .toMatchObject({ code: server, message: `server says ${server}` })
    }
  })

  test("write refuses without consent, outside data/ and for other extensions, before calling the server", async () => {
    const { host, calls, setAllowed } = fakeHost()
    for (const path of ["a.json", "../foo-bar/data/a.json", "data/page.html", "data/x.js"]) {
      expect((await rejection(handlePageRequest(host, req({ op: "write", path, content: "", expectedVersion: 0 })))).code).toBe("NOT_ALLOWED")
    }
    setAllowed(false)
    expect((await rejection(handlePageRequest(host, req({ op: "write", path: "data/a.json", content: "", expectedVersion: 0 })))).code).toBe("NOT_ALLOWED")
    expect(calls).toEqual([])
  })
})

function harness(host: PageHost) {
  const listeners = new Set<(e: Event) => void>()
  const win = {
    addEventListener: (_: string, l: (e: Event) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: Event) => void) => listeners.delete(l),
  } as unknown as Window
  const posted: Array<{ data: unknown; ports: MessagePort[] }> = []
  const frameWindow = {
    postMessage: (data: unknown, _origin: string, ports: MessagePort[] = []) => posted.push({ data, ports }),
  } as unknown as Window
  const loads = new Set<() => void>()
  const frame = {
    contentWindow: frameWindow,
    addEventListener: (_: string, l: () => void) => loads.add(l),
    removeEventListener: (_: string, l: () => void) => loads.delete(l),
  } as unknown as HTMLIFrameElement
  let closed = 0
  const bridge = createHtmlPageBridge(frame, host, () => closed++, win)
  const send = (data: unknown, source: unknown = frameWindow) => listeners.forEach((l) => l({ data, source } as unknown as Event))
  const hello = (nonce = NONCE) => send({ type: `${P}hello`, v: 1, nonce })
  const load = () => loads.forEach((l) => l())
  /** The page's end of the port, collecting replies; acks with `ack` unless it is null. */
  const pagePort = (ack: unknown = { type: `${P}ack`, nonce: NONCE }, i = 0) => {
    const port = posted[i].ports[0]
    const replies: unknown[] = []
    port.onmessage = (e) => replies.push(e.data)
    if (ack !== null) port.postMessage(ack)
    return { port, replies }
  }
  return { bridge, posted, send, hello, load, pagePort, listeners, loads, closed: () => closed }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** A host whose identity requests wait until released. */
function heldHost() {
  let release!: () => void
  const held = fakeHost({ requestIdentity: () => new Promise((r) => { release = () => r(VIEWER) }) })
  return { ...held, release: () => release() }
}

describe("createHtmlPageBridge", () => {
  test("answers hello with host and a port, and serves requests after the ack", async () => {
    const h = harness(fakeHost().host)
    h.hello()
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].data).toEqual({ type: `${P}host`, v: 1 })
    expect(h.posted[0].ports).toHaveLength(1)
    const { port, replies } = h.pagePort()
    port.postMessage({ id: 1, op: "identity" })
    port.postMessage({ id: 2, op: "rm", path: "a" })
    port.postMessage({ op: "identity" })
    port.postMessage("junk")
    await tick()
    expect(replies).toEqual([
      { id: 1, result: VIEWER },
      { id: 2, error: { code: "VALIDATION_ERROR", message: "Unknown op" } },
    ])
    h.bridge.dispose()
    port.close()
  })

  test("ignores malformed hellos and hellos from any other window", () => {
    const h = harness(fakeHost().host)
    for (const bad of [null, "hello", { type: `${P}hello`, v: 1 }, { type: `${P}hello`, v: 2, nonce: NONCE }, { type: "agent-fs-comments:hello", v: 1, path: "/" }]) h.send(bad)
    h.send({ type: `${P}hello`, v: 1, nonce: NONCE }, {})
    h.send({ type: `${P}hello`, v: 1, nonce: NONCE }, null)
    expect(h.posted).toEqual([])
    h.bridge.dispose()
  })

  test("a second hello gets nothing; the port survives the page's own load", async () => {
    const h = harness(fakeHost().host)
    h.hello()
    h.hello("fedcba9876543210fedcba9876543210")
    expect(h.posted).toHaveLength(1)
    h.load()
    const { port, replies } = h.pagePort()
    port.postMessage({ id: 1, op: "identity" })
    await tick()
    expect(replies).toHaveLength(1)
    expect(h.closed()).toBe(0)
    h.bridge.dispose()
    port.close()
  })

  test("a hello after the frame's first load is never answered", () => {
    const h = harness(fakeHost().host)
    h.load()
    h.hello()
    h.load()
    h.hello()
    expect(h.posted).toEqual([])
    h.bridge.dispose()
  })

  test("a wrong ack, or a request before the ack, closes the port for good", async () => {
    for (const first of [{ type: `${P}ack`, nonce: "fedcba9876543210fedcba9876543210" }, { type: `${P}ack` }, { id: 1, op: "identity" }]) {
      const h = harness(fakeHost().host)
      h.hello()
      const { port, replies } = h.pagePort(first)
      await tick()
      expect(h.closed()).toBe(1)
      port.postMessage({ type: `${P}ack`, nonce: NONCE })
      port.postMessage({ id: 2, op: "identity" })
      await tick()
      expect(replies).toEqual([])
      h.bridge.dispose()
      port.close()
    }
  })

  test("bye closes the port and drops the replies still running", async () => {
    const held = heldHost()
    const h = harness(held.host)
    h.hello()
    const { port, replies } = h.pagePort()
    port.postMessage({ id: 1, op: "identity" })
    await tick()
    port.postMessage({ type: `${P}bye` })
    await tick()
    expect(h.closed()).toBe(1)
    held.release()
    await tick()
    expect(replies).toEqual([])
    h.bridge.dispose()
    port.close()
  })

  test("a navigation closes the port: a reply still running is dropped, the new document gets nothing", async () => {
    const held = heldHost()
    const h = harness(held.host)
    h.hello()
    h.load()
    const { port, replies } = h.pagePort()
    port.postMessage({ id: 1, op: "identity" })
    await tick()
    h.load() // the frame navigated
    expect(h.closed()).toBe(1)
    h.hello("fedcba9876543210fedcba9876543210") // the replacement document
    expect(h.posted).toHaveLength(1)
    held.release()
    await tick()
    expect(replies).toEqual([])
    h.bridge.dispose()
    port.close()
  })

  test("refuses the 17th request in flight and messages over 2 MB at once", async () => {
    let releaseAll!: () => void
    const gate = new Promise<void>((r) => { releaseAll = r })
    const h = harness(fakeHost({}, async () => { await gate; return stat("e") }).host)
    h.hello()
    const { port, replies } = h.pagePort()
    for (let id = 1; id <= 17; id++) port.postMessage({ id, op: "stat", path: "a.json" })
    port.postMessage({ id: 18, op: "write", path: "data/a.txt", content: "x".repeat(1024 * 1024), expectedVersion: 0 })
    await tick()
    expect(replies).toEqual([
      { id: 17, error: { code: "NOT_ALLOWED", message: "At most 16 requests in flight" } },
      { id: 18, error: { code: "NOT_ALLOWED", message: "At most 16 requests in flight" } },
    ])
    releaseAll()
    await tick()
    expect(replies).toHaveLength(18)
    port.postMessage({ id: 19, op: "write", path: "data/a.txt", content: "x".repeat(2 * 1024 * 1024), expectedVersion: 0 })
    await tick()
    expect(replies.at(-1)).toEqual({ id: 19, error: { code: "NOT_ALLOWED", message: "Request is larger than 2 MB" } })
    h.bridge.dispose()
    port.close()
  })

  test("dispose closes the port and drops pending replies", async () => {
    const held = heldHost()
    const h = harness(held.host)
    h.hello()
    const { port, replies } = h.pagePort()
    port.postMessage({ id: 1, op: "identity" })
    await tick()
    h.bridge.dispose()
    expect(h.closed()).toBe(1)
    expect(h.listeners.size).toBe(0)
    expect(h.loads.size).toBe(0)
    held.release()
    await tick()
    expect(replies).toEqual([])
    port.close()
  })

  test("dispose while consent is pending closes the port and drops the answer", async () => {
    // HtmlViewer does this on sign-out and on an endpoint, org or drive change.
    const storage = memoryStorage()
    let settle!: (allow: boolean) => void
    const host = memberPageHost({ ...memberOpts(storage), ask: () => new Promise((r) => { settle = r }) })
    const h = harness(host)
    h.hello()
    const { port, replies } = h.pagePort()
    port.postMessage({ id: 1, op: "identity" })
    await tick()
    h.bridge.dispose()
    settle(false)
    await tick()
    expect(h.closed()).toBe(1)
    expect(replies).toEqual([])
    expect(hasPageAccess(SCOPE, storage)).toBe(false)
    port.close()
  })
})

const SCOPE = { endpoint: "https://api.test", userId: "u1", orgId: "o", driveId: "d", folder: FOLDER }

function memberOpts(storage: ReturnType<typeof memoryStorage>) {
  return {
    folder: FOLDER,
    scope: () => SCOPE,
    viewer: () => VIEWER,
    callOp: async <T,>() => ({ version: 2, path: "x", size: 1 }) as T,
    ask: async () => true,
    storage,
  }
}

describe("memberPageHost", () => {
  test("reads the stored decision on every identity and write request", async () => {
    const storage = memoryStorage()
    let asked = 0
    const host = memberPageHost({ ...memberOpts(storage), ask: async () => (++asked, asked === 1) })
    const write = { id: 1, op: "write", path: "data/a.json", content: "{}", expectedVersion: 1 } as PageRequest
    expect((await rejection(handlePageRequest(host, write))).code).toBe("NOT_ALLOWED")
    expect(await handlePageRequest(host, { id: 1, op: "identity" })).toEqual(VIEWER) // Allow
    expect(hasPageAccess(SCOPE, storage)).toBe(true)
    expect(await handlePageRequest(host, write)).toEqual({ version: 2 })
    expect(await handlePageRequest(host, { id: 1, op: "identity" })).toEqual(VIEWER)
    expect(asked).toBe(1)

    setPageAccess(SCOPE, false, storage) // revoked in another view or tab
    expect((await rejection(handlePageRequest(host, write))).code).toBe("NOT_ALLOWED")
    expect(await handlePageRequest(host, { id: 1, op: "identity" })).toBeNull() // asked again, declined
    expect(asked).toBe(2)
  })

  for (const [label, storage] of [
    ["setItem throws", { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError") } }],
    ["no storage", null],
  ] as const) {
    test(`when the browser will not store Allow (${label}), it holds in memory for this host until revoked`, async () => {
      const stored: boolean[] = []
      let asked = 0
      const host = memberPageHost({
        ...memberOpts(memoryStorage()),
        storage,
        ask: async () => (++asked, true),
        onAllow: (s) => stored.push(s),
      })
      const write = { id: 1, op: "write", path: "data/a.json", content: "{}", expectedVersion: 1 } as PageRequest
      expect(await handlePageRequest(host, { id: 1, op: "identity" })).toEqual(VIEWER)
      expect(stored).toEqual([false]) // shown as "for this view only"
      expect(host.allowed()).toBe(true)
      expect(await handlePageRequest(host, write)).toEqual({ version: 2 })
      expect(await handlePageRequest(host, { id: 1, op: "identity" })).toEqual(VIEWER)
      expect(asked).toBe(1)

      host.revoke()
      expect(host.allowed()).toBe(false)
      expect((await rejection(handlePageRequest(host, write))).code).toBe("NOT_ALLOWED")
    })
  }

  test("a revoke the browser will not store still holds for this host", async () => {
    const storage = memoryStorage()
    let asked = 0
    const host = memberPageHost({ ...memberOpts(storage), ask: async () => (++asked, true) })
    const write = { id: 1, op: "write", path: "data/a.json", content: "{}", expectedVersion: 1 } as PageRequest
    await host.requestIdentity()
    expect(hasPageAccess(SCOPE, storage)).toBe(true)
    storage.setItem = () => { throw new Error("QuotaExceededError") }

    expect(host.revoke()).toBe(false) // shown as revoked in this view only
    expect(hasPageAccess(SCOPE, storage)).toBe(true) // still stored for other views
    expect(host.allowed()).toBe(false)
    expect((await rejection(handlePageRequest(host, write))).code).toBe("NOT_ALLOWED")
    // Asking again and allowing holds in memory.
    expect(await host.requestIdentity()).toEqual(VIEWER)
    expect(asked).toBe(2)
    expect(await handlePageRequest(host, write)).toEqual({ version: 2 })
  })

  test("a stored Allow is reported as stored, and revoke clears it", async () => {
    const storage = memoryStorage()
    const stored: boolean[] = []
    const host = memberPageHost({ ...memberOpts(storage), onAllow: (s) => stored.push(s) })
    await host.requestIdentity()
    expect(stored).toEqual([true])
    expect(hasPageAccess(SCOPE, storage)).toBe(true)
    expect(host.revoke()).toBe(true)
    expect(hasPageAccess(SCOPE, storage)).toBe(false)
    expect(host.allowed()).toBe(false)
  })

  test("no scope (member unknown) means no identity and no writes, without asking", async () => {
    let asked = false
    const host = memberPageHost({ ...memberOpts(memoryStorage()), scope: () => null, ask: async () => (asked = true) })
    expect(await host.requestIdentity()).toBeNull()
    expect(host.allowed()).toBe(false)
    expect(asked).toBe(false)
  })
})
