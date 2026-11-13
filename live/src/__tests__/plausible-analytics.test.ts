import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import vm from "node:vm"

// Builds the hosted-UI head snippet (VITE_PLAUSIBLE_ANALYTICS=1), evaluates
// the inline init stub in a fake window, then builds each request payload the
// way the Plausible tracker does (`u: location.href`, outbound-link
// `props.url`) and runs it through the configured `transformRequest`, if any.

const API_KEY = `af_${"0".repeat(64)}`
const API_URL = "http://127.0.0.1:1"
const INVITE_TOKEN = "dummytoken"
const SHARE_TOKEN = "sharetokendummy"

type Tag = { tag: string; attrs?: Record<string, unknown>; children?: string; injectTo?: string }

let tags: Tag[] = []
const prevFlag = process.env.VITE_PLAUSIBLE_ANALYTICS

beforeAll(async () => {
  process.env.VITE_PLAUSIBLE_ANALYTICS = "1"
  const config = (await import("../../vite.config.ts")).default as { plugins: unknown[] }
  const plugin = (config.plugins.flat(Infinity) as { name?: string; transformIndexHtml?: () => Tag[] }[]).find(
    (p) => p?.name === "plausible-analytics",
  )
  tags = plugin?.transformIndexHtml?.() ?? []
})

afterAll(() => {
  if (prevFlag === undefined) delete process.env.VITE_PLAUSIBLE_ANALYTICS
  else process.env.VITE_PLAUSIBLE_ANALYTICS = prevFlag
})

function fakeLocation(href: string) {
  const u = new URL(href)
  return { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, host: u.host, hostname: u.hostname, protocol: u.protocol }
}

/** Run the inline stub; return its init options and a way to send payloads. */
function loadStub(href: string) {
  const stub = tags.find((t) => t.tag === "script" && typeof t.children === "string")?.children ?? ""
  const ctx: Record<string, any> = { location: fakeLocation(href), document: { referrer: "" }, URL, RegExp }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(stub, ctx)
  const send = (payload: Record<string, unknown>) => {
    const opts = (ctx.plausible?.o ?? {}) as { transformRequest?: (p: unknown) => unknown }
    const out = opts.transformRequest ? opts.transformRequest(structuredClone(payload)) : payload
    return JSON.stringify(out ?? null)
  }
  return { ctx, send }
}

function pageview(href: string) {
  const { send } = loadStub(href)
  return send({ n: "pageview", v: 37, u: href, d: "live.agent-fs.dev", r: null })
}

describe("hosted UI analytics snippet", () => {
  test("control: injects the tracker and a stub that records init options", () => {
    expect(tags.some((t) => typeof t.attrs?.src === "string" && String(t.attrs.src).startsWith("https://plausible.io/js/pa-"))).toBe(true)
    const { ctx } = loadStub("https://live.agent-fs.dev/files")
    expect(typeof ctx.plausible).toBe("function")
    expect(typeof ctx.plausible.init).toBe("function")
    expect(typeof ctx.plausible.o).toBe("object")
  })

  test("control: a plain route still reports a page URL on the UI origin", () => {
    const body = JSON.parse(pageview("https://live.agent-fs.dev/files"))
    expect(String(body.u).startsWith("https://live.agent-fs.dev/")).toBe(true)
  })

  test("auto-connect link: no API key or server URL in the pageview", () => {
    const body = pageview(`https://live.agent-fs.dev/credentials?apiUrl=${encodeURIComponent(API_URL)}&apiKey=${API_KEY}`)
    expect(body).not.toContain(API_KEY)
    expect(body).not.toContain("127.0.0.1")
  })

  test("invite link: no token or server URL in the pageview", () => {
    const body = pageview(`https://live.agent-fs.dev/invite?apiUrl=${encodeURIComponent(API_URL)}#${INVITE_TOKEN}`)
    expect(body).not.toContain(INVITE_TOKEN)
    expect(body).not.toContain("127.0.0.1")
  })

  test("file route: no org, drive or file name in the pageview", () => {
    const body = pageview("https://live.agent-fs.dev/file/~/org_dummy/drv_dummy/secret-name.md")
    expect(body).not.toContain("org_dummy")
    expect(body).not.toContain("drv_dummy")
    expect(body).not.toContain("secret-name")
    expect(JSON.parse(body).u).toBe("https://live.agent-fs.dev/file/~/:orgId/:driveId/*")
  })

  test("outbound link click: no share token in the event", () => {
    const href = "https://live.agent-fs.dev/file/~/org_dummy/drv_dummy/a.md"
    const { send } = loadStub(href)
    const body = send({
      n: "Outbound Link: Click",
      v: 37,
      u: href,
      d: "live.agent-fs.dev",
      r: null,
      p: { url: `${API_URL}/share/${SHARE_TOKEN}` },
    })
    expect(body).not.toContain(SHARE_TOKEN)
  })
})
