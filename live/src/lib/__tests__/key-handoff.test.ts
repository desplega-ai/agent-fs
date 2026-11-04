import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import {
  applyKeyHandoff,
  continueWithSwarmHref,
  credentialsRedirect,
  isAppReturnPath,
  orgIdFromAppPath,
  parseKeyHandoff,
  takeKeyHandoff,
} from "../key-handoff"
import { getActiveCredential, getCredentials, saveCredential, setActiveCredential } from "@/stores/credentials"

const KEY = `af_${"a1".repeat(32)}`

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.get(k) ?? null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
const storage = new MemoryStorage()
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
  else Reflect.deleteProperty(globalThis, "localStorage")
})
beforeEach(() => storage.clear())

function fakeWindow(url: string, saved?: string) {
  const u = new URL(url)
  const calls: string[] = []
  const win = {
    __agentFsKeyHandoff: saved,
    location: { hash: u.hash, pathname: u.pathname, search: u.search },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, next?: string | URL | null) => {
        calls.push(String(next))
        win.location.hash = ""
      },
    },
  }
  return { win, calls }
}

describe("parseKeyHandoff", () => {
  test("reads the key and the endpoint from the fragment", () => {
    expect(parseKeyHandoff(`#key=${KEY}&apiUrl=${encodeURIComponent("https://fs.example.com/")}`)).toEqual({
      apiKey: KEY,
      endpoint: "https://fs.example.com",
    })
  })

  test("an endpoint that is not http(s) is dropped", () => {
    expect(parseKeyHandoff(`#key=${KEY}&apiUrl=javascript:alert(1)`)).toEqual({ apiKey: KEY, endpoint: null })
    expect(parseKeyHandoff(`#key=${KEY}`)).toEqual({ apiKey: KEY, endpoint: null })
  })

  test("anything that is not an af_ key is not a handoff", () => {
    expect(parseKeyHandoff("")).toBeNull()
    expect(parseKeyHandoff("#section-2")).toBeNull()
    expect(parseKeyHandoff("#key=sk-123")).toBeNull()
    expect(parseKeyHandoff("#key=af_<script>")).toBeNull()
  })
})

describe("takeKeyHandoff", () => {
  test("strips the fragment and keeps the path and query", () => {
    const { win, calls } = fakeWindow(`https://live.test/file/~/o/d/a.md?apiUrl=x#key=${KEY}`)
    expect(takeKeyHandoff(win)?.apiKey).toBe(KEY)
    expect(calls).toEqual(["/file/~/o/d/a.md?apiUrl=x"])
    expect(win.location.hash).toBe("")
  })

  test("uses the copy index.html saved, once, without touching history again", () => {
    const { win, calls } = fakeWindow("https://live.test/file/~/o/d/a.md", `#key=${KEY}`)
    expect(takeKeyHandoff(win)?.apiKey).toBe(KEY)
    expect(calls).toEqual([])
    expect(win.__agentFsKeyHandoff).toBeUndefined()
    expect(takeKeyHandoff(win)).toBeNull()
  })

  test("an invalid key is still stripped from the address bar", () => {
    const { win, calls } = fakeWindow("https://live.test/files#key=nope")
    expect(takeKeyHandoff(win)).toBeNull()
    expect(calls).toEqual(["/files"])
  })

  test("other fragments are left alone", () => {
    const { win, calls } = fakeWindow("https://live.test/file/~/o/d/a.md#heading")
    expect(takeKeyHandoff(win)).toBeNull()
    expect(calls).toEqual([])
  })
})

describe("applyKeyHandoff", () => {
  test("saves the key for the fragment endpoint, makes it active, and forgets the old org", () => {
    localStorage.setItem("agent-fs-active-org", "old-org")
    localStorage.setItem("agent-fs-active-drive", "old-drive")
    const result = applyKeyHandoff({ apiKey: KEY, endpoint: "https://fs.example.com" })
    expect(result.ok).toBe(true)
    expect(getActiveCredential()).toMatchObject({ endpoint: "https://fs.example.com", apiKey: KEY, name: "fs.example.com" })
    expect(localStorage.getItem("agent-fs-active-org")).toBeNull()
    expect(localStorage.getItem("agent-fs-active-drive")).toBeNull()
  })

  test("the same key twice is saved once", () => {
    applyKeyHandoff({ apiKey: KEY, endpoint: "https://fs.example.com" })
    applyKeyHandoff({ apiKey: KEY, endpoint: "https://fs.example.com/" })
    expect(getCredentials()).toHaveLength(1)
  })

  test("without a fragment endpoint it falls back to the active account's server", () => {
    saveCredential({ id: "c1", name: "old", endpoint: "https://fs.example.com/", apiKey: "af_old_key_value_12345" })
    setActiveCredential("c1")
    expect(applyKeyHandoff({ apiKey: KEY, endpoint: null }).ok).toBe(true)
    expect(getActiveCredential()).toMatchObject({ endpoint: "https://fs.example.com", apiKey: KEY })
  })

  test("with no endpoint at all nothing is saved", () => {
    expect(applyKeyHandoff({ apiKey: KEY, endpoint: null })).toEqual({ ok: false })
    expect(getCredentials()).toEqual([])
  })
})

describe("deep links through the connect form", () => {
  test("app paths are allowed back, other paths are not", () => {
    for (const ok of [
      "/file/~/o/d/a.md",
      "/file/~/o/d/",
      "/file/~/o/d/dir/a%20b.md?apiUrl=https%3A%2F%2Ffs.test",
      "/detail/~/o/d/a.md",
      "/sql/~/o/d",
      "/members/~/o/d",
      "/orgs/o/files/x",
      "/keys",
      "/files",
    ]) expect(isAppReturnPath(ok)).toBe(true)
    for (const bad of ["//evil.test/file/~/o/d/a", "https://evil.test/", "/credentials", "/file/~/o", "javascript:alert(1)", "/files#x"]) {
      expect(isAppReturnPath(bad)).toBe(false)
    }
  })

  test("the org comes from the deep link", () => {
    expect(orgIdFromAppPath("/file/~/org-1/d/a.md")).toBe("org-1")
    expect(orgIdFromAppPath("/members/~/org-2/d")).toBe("org-2")
    expect(orgIdFromAppPath("/orgs/org-3/files/")).toBe("org-3")
    expect(orgIdFromAppPath("/files")).toBeNull()
  })

  test("the guard keeps the path in next and never puts a key there", () => {
    expect(credentialsRedirect({ pathname: "/file/~/o/d/a.md", search: "?apiUrl=https%3A%2F%2Ffs.test" })).toBe(
      "/credentials?apiUrl=https%3A%2F%2Ffs.test&next=%2Ffile%2F%7E%2Fo%2Fd%2Fa.md%3FapiUrl%3Dhttps%253A%252F%252Ffs.test",
    )
    const withKey = new URLSearchParams(
      credentialsRedirect({ pathname: "/file/~/o/d/a.md", search: "?apiUrl=x&apiKey=af_secret" }).split("?")[1],
    )
    expect(withKey.get("apiKey")).toBe("af_secret") // forwarded for auto-connect, as before
    expect(withKey.get("next")).toBe("/file/~/o/d/a.md?apiUrl=x")
    expect(credentialsRedirect({ pathname: "/files", search: "" })).toBe("/credentials")
  })

  test("the Continue link sends the full live URL as return_to", () => {
    expect(continueWithSwarmHref("https://swarm.test/", "https://live.test/file/~/o/d/a b.md?apiUrl=x")).toBe(
      "https://swarm.test/fs/continue?return_to=https%3A%2F%2Flive.test%2Ffile%2F~%2Fo%2Fd%2Fa%20b.md%3FapiUrl%3Dx",
    )
  })
})
