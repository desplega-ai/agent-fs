// Run with file isolation because this suite replaces the auth context.
// From live/: bun test --isolate src/components/__tests__/uuid-resolver.test.tsx
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { Root } from "react-dom/client"
import { AgentFsClient } from "../../api/client"
import type { Credential } from "../../stores/credentials"

GlobalRegistrator.register({ url: "http://localhost/" })
const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query")

interface Session {
  credential: Credential
  user: { userId: string } | undefined
  client: AgentFsClient
  orgId: string
  driveId: string
}

let auth: Session
mock.module("../../contexts/auth", () => ({ useAuth: () => auth }))
const { useUuidName } = await import("../../lib/uuid-resolver")
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const uuid = "d727c2aa-b15d-4267-b1ba-ce120c1e369c"
const folder = `nested/${uuid}`
let root: Root
let host: HTMLDivElement
let queryClient: InstanceType<typeof QueryClient>
let fetchMock: ReturnType<typeof spyOn>
let files: Map<string, Record<string, string>>
let ops: { endpoint: string; apiKey: string; op: string; path: string; limit?: number; offset?: number }[]

function session(credential: Partial<Credential> = {}, userId = "alice"): Session {
  const saved = { id: "account", name: "Account", endpoint: "http://agent-fs.test", apiKey: "alice-key", ...credential }
  return { credential: saved, user: { userId }, client: new AgentFsClient(saved), orgId: "org", driveId: "drive" }
}

function setFiles(owner: Session, metadata?: string, name?: string) {
  const entries: Record<string, string> = {}
  if (metadata !== undefined) entries[`${folder}/meta.json`] = metadata
  if (name !== undefined) entries[`${folder}/.name`] = name
  files.set(JSON.stringify([owner.credential.endpoint, owner.credential.apiKey]), entries)
}

function Probe() {
  const name = useUuidName("nested", uuid)
  return <output>{name ?? "unresolved"}</output>
}

async function render(visible = true) {
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{visible && <Probe />}</QueryClientProvider>)
  })
  for (let i = 0; i < 100; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    if (queryClient.isFetching() === 0) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
      if (queryClient.isFetching() === 0) return
    }
  }
  throw new Error("The UUID request did not finish")
}

beforeEach(() => {
  localStorage.clear()
  auth = session()
  files = new Map()
  ops = []
  // Automatic retries must remain disabled even when the app enables them.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 1, gcTime: Infinity } } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const apiKey = new Headers(init?.headers).get("Authorization")!.slice(7)
    const body = JSON.parse(String(init?.body))
    ops.push({ endpoint: url.origin, apiKey, ...body })
    const content = files.get(JSON.stringify([url.origin, apiKey]))?.[body.path]
    if (body.op !== "cat" || url.pathname !== "/orgs/org/ops") throw new Error("Unexpected UUID request")
    if (content === undefined) return Response.json({ error: "NOT_FOUND" }, { status: 404 })
    const lines = content.split("\n")
    const offset = body.offset ?? 0
    const limit = body.limit ?? 200
    return Response.json({ content: lines.slice(offset, offset + limit).join("\n"), totalLines: lines.length, truncated: offset + limit < lines.length })
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  queryClient.clear()
  host.remove()
  fetchMock.mockRestore()
})

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

test.each(["endpoint", "credential", "user"] as const)("UUID caches isolate changes to the %s", async (identity) => {
  const original = auth
  setFiles(original, '{"name":"Original"}')
  await render()
  expect(host.textContent).toBe("Original")

  auth = identity === "endpoint"
    ? session({ endpoint: "http://other-agent-fs.test" })
    : identity === "credential"
      ? session({ id: "other-account" })
      : session({ apiKey: "bob-key" }, "bob")
  const changed = auth
  setFiles(changed, '{"name":"Changed"}')
  await render()
  expect(host.textContent).toBe("Changed")
  expect(ops).toHaveLength(2)

  // Each identity retains its own result in the same QueryClient.
  auth = original
  await render()
  expect(host.textContent).toBe("Original")
  expect(ops).toHaveLength(2)

  // A new QueryClient must read each identity's persisted result separately.
  await render(false)
  queryClient.clear()
  await render()
  expect(host.textContent).toBe("Original")
  auth = changed
  await render()
  expect(host.textContent).toBe("Changed")
  expect(ops).toHaveLength(2)
})

test("UUID resolution waits for the resolved user identity", async () => {
  setFiles(auth, '{"name":"Authenticated"}')
  auth = { ...auth, user: undefined }
  await render()
  expect(host.textContent).toBe("unresolved")
  expect(ops).toEqual([])
  auth = { ...auth, user: { userId: "alice" } }
  await render()
  expect(host.textContent).toBe("Authenticated")
  expect(ops).toHaveLength(1)
})

test("UUID resolution parses complete metadata beyond cat's default 200 lines", async () => {
  const metadata = ["{", '  "name": "  Multiline Agent  ",', '  "padding": [', ...Array.from({ length: 250 }, (_, i) => `    ${i}${i < 249 ? "," : ""}`), "  ]", "}"].join("\n")
  expect(metadata.split("\n")).toHaveLength(255)
  setFiles(auth, metadata)
  await render()
  expect(host.textContent).toBe("Multiline Agent")
  expect(ops).toHaveLength(1)
  expect(ops[0].limit).toBe(1000)
})

test("truncated metadata uses and caches the first line of .name", async () => {
  setFiles(auth, '{"name":"Incomplete"}' + "\n".repeat(1000), "  Fallback Agent  \r\nignored")
  await render()
  expect(host.textContent).toBe("Fallback Agent")
  expect(ops.map(({ path, limit }) => ({ path, limit }))).toEqual([
    { path: `${folder}/meta.json`, limit: 1000 },
    { path: `${folder}/.name`, limit: 1 },
  ])
  await render(false)
  queryClient.clear()
  await render()
  expect(host.textContent).toBe("Fallback Agent")
  expect(ops).toHaveLength(2)
})

test("metadata beyond the bound stays retryable when .name is absent", async () => {
  setFiles(auth, '{"name":"Incomplete"}' + "\n".repeat(1000))
  await render()
  expect(host.textContent).toBe("unresolved")
  expect(ops).toHaveLength(2)
  expect(localStorage.getItem("liveui:uuid-cache:v3")).toBeNull()
  expect(queryClient.getQueryCache().find({ queryKey: ["uuid-name"], exact: false })?.state.status).toBe("error")

  setFiles(auth, '{"name":"Recovered"}')
  await render(false)
  await render()
  expect(host.textContent).toBe("Recovered")
  expect(ops).toHaveLength(3)
})

test("unscoped labels and misses from earlier cache versions do not suppress metadata", async () => {
  localStorage.setItem("liveui:uuid-cache:v2", JSON.stringify({ [`org::drive::${folder}`]: null }))
  setFiles(auth, '{"name":"Recovered"}')
  await render()
  expect(host.textContent).toBe("Recovered")
  expect(ops).toHaveLength(1)
})
