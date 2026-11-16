import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement, useEffect } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router"
import type { Root } from "react-dom/client"
import type { LsEntry, LsResult } from "@/api/types"

const dir = (name: string): LsEntry => ({ name, type: "directory", size: 0 })
const file = (name: string): LsEntry => ({ name, type: "file", size: 1 })
const folder = (i: number) => `area-${String(i).padStart(3, "0")}`
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await act(() => pause())
  }
  expect(check()).toBe(true)
}

let root: Root | undefined
let queryClient: QueryClient
let host: HTMLDivElement
let treeExpansionStore: typeof import("@/stores/tree-expansion").treeExpansionStore
let selectFile: (path: string) => void
let switchDrive: (drive: string, path: string) => void
const originalFetch = globalThis.fetch

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ treeExpansionStore } = await import("@/stores/tree-expansion"))
})

afterEach(async () => {
  await act(() => root?.unmount())
  root = undefined
  queryClient?.clear()
  treeExpansionStore.clear()
  host?.remove()
  globalThis.fetch = originalFetch
  const { resetRevealSupport } = await import("@/lib/reveal")
  resetRevealSupport()
  await pause()
})

afterAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  await GlobalRegistrator.unregister()
})

async function mountTree(options: {
  selected?: string
  expanded?: string[]
  cached?: Record<string, LsResult>
  supportsReveal?: boolean
  holdListings?: boolean
  holdReveal?: boolean
} = {}) {
  localStorage.clear()
  localStorage.setItem("agent-fs-credentials", JSON.stringify([
    { id: "test", name: "Test", endpoint: "http://fixture.test", apiKey: "test" },
  ]))
  localStorage.setItem("agent-fs-active-credential", "test")
  localStorage.setItem("agent-fs-active-org", "org")
  localStorage.setItem("agent-fs-active-drive", "drive")
  treeExpansionStore.expandMany(options.expanded ?? [])
  queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } })
  for (const [path, data] of Object.entries(options.cached ?? {})) {
    queryClient.setQueryData(["ls", "org", "drive", path], data)
  }
  const calls: { op: string; path: string; drive: string }[] = []
  const pending: (() => void)[] = []
  let active = 0
  let peak = 0
  const listings: Record<string, LsResult> = {
    "": { entries: Array.from({ length: 1000 }, (_, i) => dir(folder(i))) },
    "area-900": { entries: [dir("sub")] },
    "area-900/sub": { entries: [file("target.md"), file("other.md")] },
  }
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.endsWith("/auth/me")) return Response.json({ userId: "test", defaultOrgId: "org", defaultDriveId: "drive" })
    if (url.endsWith("/orgs")) return Response.json({ orgs: [{ id: "org", name: "Test" }] })
    if (url.endsWith("/drives")) return Response.json({ drives: [{ id: "drive", name: "Test" }] })
    if (url.endsWith("/health")) return Response.json({ features: [] })
    if (!url.endsWith("/ops")) throw new Error(`Unexpected request: ${url}`)
    const params = JSON.parse(String(init?.body))
    const path = params.path ?? ""
    calls.push({ op: params.op, path, drive: params.driveId })
    if (params.op === "reveal") {
      if (options.supportsReveal === false) return Response.json({ error: "UNKNOWN_OP", message: "Unknown operation: reveal" }, { status: 400 })
      if (options.holdReveal) await new Promise<void>((resolve) => pending.push(resolve))
      const parts = path.split("/")
      const parents = ["", ...parts.slice(0, -1).map((_: string, i: number) => parts.slice(0, i + 1).join("/"))]
      return Response.json({ path, stat: {}, listings: parents.map((p) => ({ path: p, entries: listings[p]?.entries ?? [] })) })
    }
    if (params.op !== "ls") throw new Error(`Unexpected operation: ${params.op}`)
    if (path && options.holdListings) {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve, reject) => {
        pending.push(resolve)
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
      }).finally(() => active--)
    }
    return Response.json(listings[path] ?? { entries: [file("entry.md")] })
  }) as typeof fetch

  const { AuthProvider, useAuth } = await import("@/contexts/auth")
  const { BrowserProvider, useBrowser } = await import("@/contexts/browser")
  const { FileTree } = await import("../FileTree")
  const { TooltipProvider } = await import("@/components/ui/tooltip")
  function Fixture() {
    const browser = useBrowser()
    const auth = useAuth()
    const navigate = useNavigate()
    const params = useParams()
    selectFile = browser.selectFile
    switchDrive = (drive, path) => {
      auth.setDriveId(drive)
      navigate(`/file/~/org/${drive}/${path}`)
    }
    useEffect(() => browser.setSelectedFile(params["*"] || null), [params["*"]])
    return <FileTree />
  }
  host = document.createElement("div")
  host.style.overflowY = "auto"
  Object.defineProperty(host, "clientHeight", { value: 280 })
  document.body.appendChild(host)
  const { createRoot } = await import("react-dom/client")
  root = createRoot(host)
  await act(() => root!.render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/file/~/org/drive/${options.selected ?? ""}`]}>
        <AuthProvider><BrowserProvider><TooltipProvider>
          <Routes><Route path="/file/~/:orgId/:driveId/*" element={createElement(Fixture)} /></Routes>
        </TooltipProvider></BrowserProvider></AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  ))
  return {
    calls, listings, pending, peak: () => peak,
    releaseListings: () => {
      options.holdListings = false
      pending.splice(0).forEach((resolve) => resolve())
    },
  }
}

test("restored folders load only on demand with at most four concurrent listings", async () => {
  const expanded = Array.from({ length: 1000 }, (_, i) => folder(i))
  const fixture = await mountTree({ expanded, holdListings: true })
  await until(() => fixture.calls.filter((c) => c.op === "ls" && c.path).length >= 4)
  await act(() => pause(60))
  expect(fixture.peak()).toBeLessThanOrEqual(4)
  expect(fixture.calls.some((c) => c.path === "area-999")).toBe(false)
  expect(JSON.parse(localStorage.getItem("liveui:tree:expanded")!)).toEqual(expanded)

  await act(async () => {
    fixture.releaseListings()
    await pause(100)
  })
  expect(fixture.calls.filter((c) => c.op === "ls").length).toBeLessThan(30)
  expect(fixture.calls.some((c) => c.path === "area-999")).toBe(false)

  await act(() => {
    host.scrollTop = 700 * 28
    host.dispatchEvent(new Event("scroll"))
  })
  await until(() => fixture.calls.some((c) => c.path.startsWith("area-6")))
  // The last row stays mounted for keyboard focus but must not load until used.
  expect(fixture.calls.some((c) => c.path === "area-999")).toBe(false)
  await act(() => host.querySelector<HTMLButtonElement>('[data-tree-path="area-999"]')!.focus())
  await until(() => fixture.calls.some((c) => c.path === "area-999"))
  expect(treeExpansionStore.isExpanded("area-999")).toBe(true)
})

test("a cold nested selection uses reveal without a separate root listing", async () => {
  const fixture = await mountTree({ selected: "area-900/sub/target.md", holdReveal: true })
  await until(() => fixture.calls.some((c) => c.op === "reveal"))
  expect(fixture.calls.filter((c) => c.op === "ls")).toEqual([])
  await act(() => fixture.pending.shift()!())
  await until(() => host.querySelector('[data-tree-path="area-900/sub/target.md"]') !== null)
  expect(treeExpansionStore.isExpanded("area-900/sub")).toBe(true)
  expect(fixture.calls.filter((c) => c.op === "ls")).toEqual([])
})

test("invalidation still bounds concurrent listing requests", async () => {
  const expanded = Array.from({ length: 20 }, (_, i) => folder(i))
  const fixture = await mountTree({
    expanded,
    holdListings: true,
    cached: Object.fromEntries([
      ["", { entries: expanded.map(dir) }],
      ...expanded.map((path) => [path, { entries: [] }]),
    ]),
  })
  await until(() => host.querySelector('[data-tree-path="area-000"]') !== null)
  await act(() => { void queryClient.invalidateQueries({ queryKey: ["ls", "org", "drive"] }) })
  await until(() => fixture.calls.filter((c) => c.op === "ls" && c.path).length >= 4)
  expect(fixture.peak()).toBe(4)
  expect(fixture.calls.some((c) => c.path === "area-019")).toBe(false)
})

test("fresh ancestor listings reveal a selected file without network requests", async () => {
  const fixture = await mountTree({
    selected: "area-900/sub/target.md",
    cached: {
      "": { entries: [dir("area-900")] },
      "area-900": { entries: [dir("sub")] },
      "area-900/sub": { entries: [file("target.md"), file("other.md")] },
    },
  })
  await until(() => host.querySelector('[data-tree-path="area-900/sub/target.md"]') !== null)
  await act(async () => {
    selectFile("area-900/sub/other.md")
    await pause(60)
  })
  expect(fixture.calls).toEqual([])
})

test("a nested selection takes priority over restored folders on an old server", async () => {
  const expanded = Array.from({ length: 20 }, (_, i) => folder(i))
  const fixture = await mountTree({
    selected: "area-900/sub/target.md", expanded, supportsReveal: false,
  })
  await until(() => host.querySelector('[data-tree-path="area-900/sub/target.md"]') !== null)
  expect(fixture.calls.slice(0, 4).map((c) => `${c.op} ${c.path}`)).toEqual([
    "reveal area-900/sub/target.md", "ls ", "ls area-900", "ls area-900/sub",
  ])
  expect(fixture.calls.filter((c) => c.op === "ls" && c.path === "")).toHaveLength(1)
  expect(fixture.calls.some((c) => c.path === "area-019")).toBe(false)
  for (const path of expanded) expect(treeExpansionStore.isExpanded(path)).toBe(true)
})

test("a newly created file refreshes its parent even when that listing is fresh", async () => {
  const fixture = await mountTree({
    selected: "area-900/sub/target.md", supportsReveal: false,
    cached: {
      "": { entries: [dir("area-900")] },
      "area-900": { entries: [dir("sub")] },
      "area-900/sub": { entries: [] },
    },
  })
  await until(() => host.querySelector('[data-tree-path="area-900/sub/target.md"]') !== null)
  expect(fixture.calls.map((c) => `${c.op} ${c.path}`)).toEqual([
    "reveal area-900/sub/target.md", "ls area-900/sub",
  ])
})

test("a late reveal from the previous drive cannot seed or expand the current tree", async () => {
  const fixture = await mountTree({ selected: "area-900/sub/target.md", holdReveal: true })
  await until(() => fixture.calls.some((c) => c.op === "reveal"))
  fixture.listings["area-800"] = { entries: [file("new.md")] }
  await act(() => switchDrive("next", "area-800/new.md"))
  await until(() => fixture.calls.filter((c) => c.op === "reveal").length === 2)
  await act(async () => {
    fixture.pending.shift()!()
    await pause(60)
  })
  expect(treeExpansionStore.isExpanded("area-900")).toBe(false)
  expect(queryClient.getQueryData(["ls", "org", "drive", "area-900"])).toBeUndefined()
  expect(queryClient.getQueryData(["ls", "org", "next", "area-900"])).toBeUndefined()
  await act(() => fixture.pending.shift()!())
  await until(() => host.querySelector('[data-tree-path="area-800/new.md"]') !== null)
  expect(fixture.calls.filter((c) => c.op === "reveal").map((c) => c.drive)).toEqual(["drive", "next"])
})
