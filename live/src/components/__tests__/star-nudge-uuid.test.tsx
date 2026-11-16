// Isolate files so library tests cannot replace this component's toast module.
// From live/: bun test --isolate src/
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { Root } from "react-dom/client"
import type { Drive } from "../../api/types"

GlobalRegistrator.register({ url: "http://localhost/" })
const { act, StrictMode } = await import("react")
const { createRoot } = await import("react-dom/client")
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query")
const { MemoryRouter } = await import("react-router")
const { AuthProvider, useAuth } = await import("../../contexts/auth")
const { StarNudge } = await import("../StarNudge")
const { useUuidName } = await import("../../lib/uuid-resolver")
const { useToasts } = await import("../../stores/toast")
const { saveCredential, setActiveCredential } = await import("../../stores/credentials")
const { starNudgeKey } = await import("../../lib/star-nudge")
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const endpoint = "http://agent-fs.test"
const uuid = "d727c2aa-b15d-4267-b1ba-ce120c1e369c"
const folder = `nested/${uuid}`
let queryClient: InstanceType<typeof QueryClient>
let root: Root
let host: HTMLDivElement
let auth: ReturnType<typeof useAuth> | undefined
let drives: Drive[]
let requests: string[]
let ops: { op: string; path: string; driveId: string }[]
let files: Record<string, string>
let fetchMock: ReturnType<typeof spyOn>

function Probe({ name, parent }: { name: string; parent: string }) {
  auth = useAuth()
  const label = useUuidName(parent, name)
  const toasts = useToasts()
  return <>
    <output>{label ?? "unresolved"}</output>
    {toasts.map((toast) => <button key={toast.id} onClick={toast.onClose}>{toast.message}</button>)}
  </>
}

beforeEach(() => {
  localStorage.clear()
  auth = undefined
  drives = [{ id: "drive", name: "default", orgId: "org", fileCountLowerBound: 0 }]
  requests = []
  ops = []
  files = {}
  saveCredential({ id: "alice", name: "Alice", endpoint, apiKey: "alice-key" })
  saveCredential({ id: "bob", name: "Bob", endpoint, apiKey: "bob-key" })
  setActiveCredential("alice")
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    requests.push(path)
    if (path === "/auth/me") {
      const userId = new Headers(init?.headers).get("Authorization") === "Bearer bob-key" ? "bob" : "alice"
      return Response.json({ userId, email: `${userId}@example.com`, defaultOrgId: "org", defaultDriveId: "drive" })
    }
    if (path === "/orgs") return Response.json({ orgs: [{ id: "org", name: "org", isPersonal: false }] })
    if (path === "/orgs/org/drives") return Response.json({ drives })
    if (path === "/orgs/org/ops") {
      const body = JSON.parse(String(init?.body))
      ops.push(body)
      if (body.op === "cat" && body.path in files) {
        return Response.json({ content: files[body.path], totalLines: 1, truncated: false })
      }
      if (body.op === "ls") return Response.json({ entries: [] })
      return Response.json({ error: body.op === "cat" ? "NOT_FOUND" : "UNKNOWN_OP" }, { status: body.op === "cat" ? 404 : 400 })
    }
    throw new Error(`Unexpected request: ${path}`)
  })
})

async function settle() {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    if (auth?.user && queryClient.isFetching() === 0) {
      // Query notifications can follow request completion on the next timer.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
      if (queryClient.isFetching() === 0) return
    }
  }
  throw new Error("The UI did not finish its requests")
}

async function render(name = "ordinary-folder", parent = "nested") {
  await act(async () => {
    root.render(<StrictMode><QueryClientProvider client={queryClient}>
      <MemoryRouter><AuthProvider>
        <StarNudge />
        <Probe name={name} parent={parent} />
      </AuthProvider></MemoryRouter>
    </QueryClientProvider></StrictMode>)
  })
  await settle()
}

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

test("the nudge reuses drive metadata with no file operations or extra drive requests", async () => {
  drives = [{ ...drives[0], fileCountLowerBound: 5 }]
  await render()
  expect(host.querySelector("button")?.textContent).toBe("Enjoying agent-fs?")
  expect(ops).toEqual([])
  expect(requests.filter((path) => path.endsWith("/drives"))).toHaveLength(1)
})

test("four files and older servers stay quiet, then refreshed metadata can qualify", async () => {
  drives = [{ ...drives[0], fileCountLowerBound: 4 }]
  await render()
  expect(host.querySelector("button")).toBeNull()
  await act(async () => {
    queryClient.setQueryData(["drives", "org"], { drives: [{ id: "drive", name: "default", isDefault: true }] })
  })
  expect(host.querySelector("button")).toBeNull()
  await act(async () => {
    queryClient.setQueryData(["drives", "org"], { drives: [{ ...drives[0], fileCountLowerBound: 5 }] })
  })
  await settle()
  expect(host.querySelector("button")).not.toBeNull()
  expect(ops).toEqual([])
})

test("dismissal stays scoped to the user and drive across account changes", async () => {
  drives = [
    { ...drives[0], fileCountLowerBound: 5 },
    { id: "other-drive", name: "other", orgId: "org", fileCountLowerBound: 5 },
  ]
  await render()
  expect(host.querySelector("button")).not.toBeNull()
  await act(async () => host.querySelector("button")!.click())
  expect(localStorage.getItem(starNudgeKey(endpoint, "alice", "org", "drive"))).toBe("1")
  expect(host.querySelector("button")).toBeNull()
  await act(async () => auth!.setDriveId("other-drive"))
  await settle()
  expect(host.querySelector("button")).not.toBeNull()
  await act(async () => auth!.switchAccount("bob"))
  await settle()
  expect(host.querySelector("button")).not.toBeNull()
  expect(localStorage.getItem(starNudgeKey(endpoint, "bob", "org", "drive"))).toBeNull()
  expect(localStorage.getItem(starNudgeKey(endpoint, "alice", "org", "other-drive"))).toBeNull()
  await act(async () => auth!.switchAccount("alice"))
  await settle()
  expect(host.querySelector("button")).toBeNull()
  expect(ops).toEqual([])
})

test("UUID labels use cat and persist a trimmed meta.json name", async () => {
  files[`${folder}/meta.json`] = JSON.stringify({ name: "  Agent One  " })
  await render(uuid)
  expect(host.querySelector("output")?.textContent).toBe("Agent One")
  expect(ops).toEqual([{ op: "cat", path: `${folder}/meta.json`, limit: 1000, driveId: "drive" }])
  await act(async () => { queryClient.removeQueries({ queryKey: ["uuid-name"] }) })
  await render("ordinary-folder")
  await render(uuid)
  expect(host.querySelector("output")?.textContent).toBe("Agent One")
  expect(ops).toHaveLength(1)
})

test.each([undefined, "{bad json", '{"name":" "}'])("UUID labels use .name when metadata is unusable: %s", async (meta) => {
  if (meta !== undefined) files[`${folder}/meta.json`] = meta
  files[`${folder}/.name`] = "  Friendly Agent  \r\nignored line"
  await render(uuid)
  expect(host.querySelector("output")?.textContent).toBe("Friendly Agent")
  expect(ops).toEqual([
    { op: "cat", path: `${folder}/meta.json`, limit: 1000, driveId: "drive" },
    { op: "cat", path: `${folder}/.name`, limit: 1, driveId: "drive" },
  ])
})

test("UUID misses remain cached and ordinary folder names make no requests", async () => {
  await render()
  expect(ops).toEqual([])
  await render(uuid)
  expect(host.querySelector("output")?.textContent).toBe("unresolved")
  expect(ops.map((op) => op.op)).toEqual(["cat", "cat"])
  await act(async () => { queryClient.removeQueries({ queryKey: ["uuid-name"] }) })
  await render("ordinary-folder")
  await render(uuid)
  expect(ops).toHaveLength(2)
})

test("misses from the unsupported read operation do not suppress corrected labels", async () => {
  localStorage.setItem("liveui:uuid-cache", JSON.stringify({ [`org::drive::${folder}`]: null }))
  files[`${folder}/meta.json`] = '{"name":"Recovered"}'
  await render(uuid)
  expect(host.querySelector("output")?.textContent).toBe("Recovered")
  expect(ops).toEqual([{ op: "cat", path: `${folder}/meta.json`, limit: 1000, driveId: "drive" }])
})
