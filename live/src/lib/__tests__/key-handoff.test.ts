import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  applyKeyHandoff,
  continueWithSwarmHref,
  continueWithSwarmLink,
  credentialsRedirect,
  isAppReturnPath,
  orgIdFromAppPath,
  parseKeyHandoff,
  rememberHandoffNonce,
  signInWithKeyHandoff,
  takeKeyHandoff,
} from "../key-handoff"
import { getActiveCredential, getCredentials, saveCredential, setActiveCredential } from "@/stores/credentials"

const KEY = `af_${"a1".repeat(32)}`

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.get(k) ?? null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
  key(i: number) { return [...this.map.keys()][i] ?? null }
  get length() { return this.map.size }
  clear() { this.map.clear() }
  keys() { return [...this.map.keys()] }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
const storage = new MemoryStorage()
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
  else Reflect.deleteProperty(globalThis, "localStorage")
})
beforeEach(() => storage.clear())

const NONCE = "n0nce_n0nce_n0nce_n0nce"
const NOW = 1_700_000_000_000
const ENDPOINT = "https://fs.example.com"
const STORED = `agent-fs-key-handoff:${NONCE}`

/** A tab of live.test; tabs share `local`, as localStorage is per origin. */
function fakeWindow(url: string, saved?: string, local = new MemoryStorage()) {
  const u = new URL(url)
  const calls: string[] = []
  const win = {
    __agentFsKeyHandoff: saved,
    location: { hash: u.hash, pathname: u.pathname, search: u.search },
    localStorage: local,
    sessionStorage: new MemoryStorage(),
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, next?: string | URL | null) => {
        calls.push(String(next))
        win.location.hash = ""
      },
    },
  }
  return { win, calls, local }
}

/** A browser that showed the Continue link for ENDPOINT `ago` ms before NOW; `url` is the return. */
function startedWindow(url: string, opts: { saved?: string; ago?: number; endpoint?: string } = {}) {
  const fake = fakeWindow(url, opts.saved)
  rememberHandoffNonce(fake.win, NONCE, opts.endpoint ?? ENDPOINT, NOW - (opts.ago ?? 1000))
  return fake
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
  const fragment = `#key=${KEY}&apiUrl=${encodeURIComponent("https://fs.example.com")}`

  test("with a stored nonce: returns the key, strips fragment and nonce, keeps path and query", () => {
    const { win, calls, local } = startedWindow(`https://live.test/file/~/o/d/a.md?apiUrl=x&handoff=${NONCE}${fragment}`)
    expect(takeKeyHandoff(win, NOW)).toEqual({ apiKey: KEY, endpoint: ENDPOINT })
    expect(calls).toEqual(["/file/~/o/d/a.md?apiUrl=x"])
    expect(win.location.hash).toBe("")
    expect(local.getItem(STORED)).toBeNull()
  })

  test("a new tab opened from the link finds the nonce stored when the link was shown", () => {
    const shown = fakeWindow("https://live.test/credentials?next=%2Ffile%2F~%2Fo%2Fd%2Fa.md")
    rememberHandoffNonce(shown.win, NONCE, ENDPOINT, NOW - 1000)
    const newTab = fakeWindow(`https://live.test/file/~/o/d/a.md?handoff=${NONCE}${fragment}`, undefined, shown.local)
    expect(takeKeyHandoff(newTab.win, NOW)).toEqual({ apiKey: KEY, endpoint: ENDPOINT })
    expect(shown.local.getItem(STORED)).toBeNull()
  })

  test("the nonce works once", () => {
    const { win, local } = startedWindow(`https://live.test/file/~/o/d/a.md?handoff=${NONCE}${fragment}`)
    expect(takeKeyHandoff(win, NOW)).toMatchObject({ apiKey: KEY })
    const again = fakeWindow(`https://live.test/file/~/o/d/a.md?handoff=${NONCE}${fragment}`, undefined, local)
    expect(takeKeyHandoff(again.win, NOW)).toBe("refused")
  })

  test("several shown links each keep their own nonce", () => {
    const { win, local } = startedWindow(`https://live.test/files?handoff=${NONCE}${fragment}`)
    rememberHandoffNonce(win, "other-nonce", ENDPOINT, NOW - 500)
    expect(takeKeyHandoff(win, NOW)).toMatchObject({ apiKey: KEY })
    expect(local.keys()).toEqual(["agent-fs-key-handoff:other-nonce"])
  })

  test("uses the copy index.html saved, once, and only strips the nonce from the address bar", () => {
    const { win, calls } = startedWindow(`https://live.test/file/~/o/d/a.md?handoff=${NONCE}`, { saved: fragment })
    expect(takeKeyHandoff(win, NOW)).toMatchObject({ apiKey: KEY })
    expect(calls).toEqual(["/file/~/o/d/a.md"])
    expect(win.__agentFsKeyHandoff).toBeUndefined()
    expect(takeKeyHandoff(win, NOW)).toBeNull()
  })

  test("a crafted fragment without a nonce is stripped and refused, and leaves a pending flow alone", () => {
    const { win, calls, local } = startedWindow(`https://live.test/file/~/o/d/a.md${fragment}`)
    expect(takeKeyHandoff(win, NOW)).toBe("refused")
    expect(calls).toEqual(["/file/~/o/d/a.md"])
    expect(local.getItem(STORED)).not.toBeNull()

    const fresh = fakeWindow(`https://live.test/files${fragment}`)
    expect(takeKeyHandoff(fresh.win, NOW)).toBe("refused")
    expect(fresh.calls).toEqual(["/files"])
  })

  test("a crafted fragment the inline script saved, without a nonce, is refused", () => {
    const { win, calls } = fakeWindow("https://live.test/files", fragment)
    expect(takeKeyHandoff(win, NOW)).toBe("refused")
    expect(calls).toEqual([])
    expect(win.__agentFsKeyHandoff).toBeUndefined()
  })

  test("a wrong nonce is refused", () => {
    const wrong = startedWindow(`https://live.test/files?handoff=someone-elses-nonce${fragment}`)
    expect(takeKeyHandoff(wrong.win, NOW)).toBe("refused")
    expect(wrong.calls).toEqual(["/files"])
  })

  test("an expired nonce is refused and removed, and old entries are pruned", () => {
    const expired = startedWindow(`https://live.test/files?handoff=${NONCE}${fragment}`, { ago: 10 * 60 * 1000 + 1 })
    expect(takeKeyHandoff(expired.win, NOW)).toBe("refused")
    expect(expired.local.getItem(STORED)).toBeNull()

    const { win, local } = fakeWindow("https://live.test/credentials")
    rememberHandoffNonce(win, "old", ENDPOINT, NOW - 11 * 60 * 1000)
    local.setItem("agent-fs-key-handoff:junk", "{not json")
    local.setItem("unrelated", "kept")
    rememberHandoffNonce(win, NONCE, ENDPOINT, NOW)
    expect(local.keys().sort()).toEqual([STORED, "unrelated"])
  })

  test("showing the link again restarts its 10 minutes", () => {
    const { win } = startedWindow(`https://live.test/files?handoff=${NONCE}${fragment}`, { ago: 10 * 60 * 1000 + 1 })
    rememberHandoffNonce(win, NONCE, ENDPOINT, NOW - 1000)
    expect(takeKeyHandoff(win, NOW)).toMatchObject({ apiKey: KEY })
  })

  test("an apiUrl that is not the server the Continue area named is refused", () => {
    const evil = encodeURIComponent("https://evil.test")
    const other = startedWindow(`https://live.test/files?handoff=${NONCE}#key=${KEY}&apiUrl=${evil}`)
    expect(takeKeyHandoff(other.win, NOW)).toBe("refused")
    expect(other.local.getItem(STORED)).toBeNull()

    const otherPath = startedWindow(`https://live.test/files?handoff=${NONCE}#key=${KEY}&apiUrl=${encodeURIComponent(`${ENDPOINT}/v2`)}`)
    expect(takeKeyHandoff(otherPath.win, NOW)).toBe("refused")

    const sameNormalized = startedWindow(`https://live.test/files?handoff=${NONCE}#key=${KEY}&apiUrl=${encodeURIComponent(`${ENDPOINT}/`)}`)
    expect(takeKeyHandoff(sameNormalized.win, NOW)).toEqual({ apiKey: KEY, endpoint: ENDPOINT })
  })

  test("a foreign apiUrl never becomes the endpoint, and never from the query", () => {
    const evil = encodeURIComponent("https://evil.test")
    const crafted = fakeWindow(`https://live.test/file/~/o/d/a.md?apiUrl=${evil}#key=${KEY}&apiUrl=${evil}`)
    expect(takeKeyHandoff(crafted.win, NOW)).toBe("refused")
    expect(getCredentials()).toEqual([])

    const queryOnly = startedWindow(`https://live.test/file/~/o/d/a.md?apiUrl=${evil}&handoff=${NONCE}#key=${KEY}`)
    expect(takeKeyHandoff(queryOnly.win, NOW)).toBe("refused")
  })

  test("an invalid key is still stripped from the address bar, without the refusal toast", () => {
    const { win, calls } = startedWindow(`https://live.test/files?handoff=${NONCE}#key=nope`)
    expect(takeKeyHandoff(win, NOW)).toBeNull()
    expect(calls).toEqual(["/files"])
  })

  test("other fragments are left alone, also when a stray nonce is removed", () => {
    const plain = fakeWindow("https://live.test/file/~/o/d/a.md#heading")
    expect(takeKeyHandoff(plain.win, NOW)).toBeNull()
    expect(plain.calls).toEqual([])
    const stray = fakeWindow(`https://live.test/file/~/o/d/a.md?handoff=${NONCE}#heading`)
    expect(takeKeyHandoff(stray.win, NOW)).toBeNull()
    expect(stray.calls).toEqual(["/file/~/o/d/a.md#heading"])
  })
})

describe("signInWithKeyHandoff", () => {
  const fragment = `#key=${KEY}&apiUrl=${encodeURIComponent(ENDPOINT)}`
  function notices() {
    const shown: string[] = []
    return { shown, notify: { info: (m: string) => shown.push(`info: ${m}`), error: (m: string) => shown.push(`error: ${m}`) } }
  }

  test("a matching return signs in without a notice", () => {
    const { win } = startedWindow(`https://live.test/file/~/o/d/a.md?handoff=${NONCE}${fragment}`)
    const { shown, notify } = notices()
    signInWithKeyHandoff(win, notify, NOW)
    expect(shown).toEqual([])
    expect(getActiveCredential()).toMatchObject({ endpoint: ENDPOINT, apiKey: KEY })
  })

  test("a refused key fragment shows the neutral notice and saves nothing", () => {
    for (const url of [
      `https://live.test/files${fragment}`,
      `https://live.test/files?handoff=wrong${fragment}`,
      `https://live.test/files?handoff=${NONCE}#key=${KEY}&apiUrl=${encodeURIComponent("https://evil.test")}`,
    ]) {
      const { win } = startedWindow(url)
      const { shown, notify } = notices()
      signInWithKeyHandoff(win, notify, NOW)
      expect(shown).toEqual(["info: The sign-in link expired or was already used. Continue again."])
    }
    expect(getCredentials()).toEqual([])
  })

  test("no key fragment, no notice", () => {
    for (const url of ["https://live.test/files", `https://live.test/files?handoff=${NONCE}#heading`, `https://live.test/files?handoff=${NONCE}#key=nope`]) {
      const { win } = startedWindow(url)
      const { shown, notify } = notices()
      signInWithKeyHandoff(win, notify, NOW)
      expect(shown).toEqual([])
    }
  })
})

describe("the key strip in index.html", () => {
  const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]

  function run(url: string) {
    const { win, calls } = fakeWindow(url)
    new Function("window", "location", "sessionStorage", "history", script)(win, win.location, win.sessionStorage, win.history)
    return { win, calls }
  }

  test("runs before the app and every other script", () => {
    expect(script).toContain("__agentFsKeyHandoff")
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('<script type="module"'))
    expect(html.indexOf("<script")).toBe(html.indexOf("<script>"))
  })

  test("moves a key fragment out of the address bar into memory, keeping path and query", () => {
    const { win, calls } = run(`https://live.test/file/~/o/d/a.md?handoff=${NONCE}#key=${KEY}`)
    expect(calls).toEqual([`/file/~/o/d/a.md?handoff=${NONCE}`])
    expect(win.__agentFsKeyHandoff).toBe(`#key=${KEY}`)
  })

  test("a crafted key fragment is gone from the address bar and then ignored by the app", () => {
    const { win, calls } = run(`https://live.test/files#key=${KEY}&apiUrl=https%3A%2F%2Fevil.test`)
    expect(calls).toEqual(["/files"])
    expect(takeKeyHandoff(win, NOW)).toBe("refused")
    expect(win.__agentFsKeyHandoff).toBeUndefined()
  })

  test("other fragments stay", () => {
    const { win, calls } = run("https://live.test/file/~/o/d/a.md#heading")
    expect(calls).toEqual([])
    expect(win.__agentFsKeyHandoff).toBeUndefined()
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

  test("dot segments are refused, plain or encoded", () => {
    for (const bad of [
      "/file/~/o/d/../../../credentials",
      "/file/~/o/d/./a.md",
      "/file/~/o/d/a/..",
      "/file/~/o/d/%2e%2e/x",
      "/file/~/o/d/.%2E/x",
      "/orgs/o/files/..",
      "/file/~/o/d/a\\..\\x",
    ]) expect(isAppReturnPath(bad)).toBe(false)
    for (const ok of ["/file/~/o/d/.hidden/a.md", "/file/~/o/d/a..b.md", "/file/~/o/d/a.md?x=..%2F.."]) {
      expect(isAppReturnPath(ok)).toBe(true)
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

  test("the Continue link carries the nonce in return_to", () => {
    const link = continueWithSwarmLink({
      swarmUrl: "https://swarm.test/",
      target: "/file/~/o/d/a.md?apiUrl=https%3A%2F%2Ffs.test",
      origin: "https://live.test",
      nonce: NONCE,
      endpoint: "https://fs.test",
      endpointSaved: true,
    })!
    const returnTo = new URL(new URL(link.href).searchParams.get("return_to")!)
    expect(new URL(link.href).origin + new URL(link.href).pathname).toBe("https://swarm.test/fs/continue")
    expect(returnTo.origin + returnTo.pathname).toBe("https://live.test/file/~/o/d/a.md")
    expect(returnTo.searchParams.get("apiUrl")).toBe("https://fs.test")
    expect(returnTo.searchParams.get("handoff")).toBe(NONCE)
    expect(link).toMatchObject({ host: "swarm.test", apiHost: null })
  })

  test("a swarm URL that is not http(s) gives no link", () => {
    const base = { target: "/file/~/o/d/a.md", origin: "https://live.test", nonce: NONCE, endpoint: "https://evil.test", endpointSaved: false }
    for (const swarmUrl of ["javascript:alert(1)", "data:text/html,x", "//swarm.test", "", null, undefined, 42, { href: "https://x" }]) {
      expect(continueWithSwarmLink({ ...base, swarmUrl })).toBeNull()
    }
  })

  test("a server no saved account vouches for is named next to the swarm", () => {
    const link = continueWithSwarmLink({
      swarmUrl: "https://swarm.evil.test",
      target: "/file/~/o/d/a.md",
      origin: "https://live.test",
      nonce: NONCE,
      endpoint: "https://fs.evil.test:8443",
      endpointSaved: false,
    })
    expect(link).toMatchObject({ host: "swarm.evil.test", apiHost: "fs.evil.test:8443" })
  })
})
