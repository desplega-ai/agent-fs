import { describe, expect, test } from "bun:test"
import { routeTemplate, trackSessionStart, type TelemetryDeps } from "../telemetry"

function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

function deps(overrides: Partial<TelemetryDeps> = {}) {
  const bodies: any[] = []
  const d: TelemetryDeps = {
    enabled: true,
    doNotTrack: null,
    hostname: "live.agent-fs.dev",
    pathname: "/file/~/org_123/drive_456/secret/report.pdf",
    version: "0.13.9",
    local: memoryStorage(),
    session: memoryStorage(),
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch,
    ...overrides,
  }
  return { d, bodies }
}

describe("live telemetry", () => {
  test("sends one anonymous session event per browser session", () => {
    const { d, bodies } = deps()
    trackSessionStart(d)
    trackSessionStart(d)
    expect(bodies).toHaveLength(1)
    expect(bodies[0].product).toBe("agent-fs")
    expect(bodies[0].event).toBe("live.session_started")
    expect(bodies[0].actor_mode).toBe("anonymous")
    expect(bodies[0].actor_anonymous_id).toMatch(/^browser_[0-9a-f]{16}$/)
    expect(bodies[0].properties).toEqual({
      is_cloud: true,
      version: "0.13.9",
      entry_route: "/file/~/:orgId/:driveId/*",
    })
    const raw = JSON.stringify(bodies[0])
    expect(raw).not.toContain("org_123")
    expect(raw).not.toContain("drive_456")
    expect(raw).not.toContain("report.pdf")
  })

  test("reuses the browser ID across sessions", () => {
    const local = memoryStorage()
    const first = deps({ local })
    const second = deps({ local })
    trackSessionStart(first.d)
    trackSessionStart(second.d)
    expect(second.bodies[0].actor_anonymous_id).toBe(first.bodies[0].actor_anonymous_id)
  })

  test("self-hosted origins report is_cloud false", () => {
    const { d, bodies } = deps({ hostname: "files.example.com" })
    trackSessionStart(d)
    expect(bodies[0].properties.is_cloud).toBe(false)
  })

  test("disabled builds and Do Not Track send nothing", () => {
    const off = deps({ enabled: false })
    trackSessionStart(off.d)
    const dnt = deps({ doNotTrack: "1" })
    trackSessionStart(dnt.d)
    expect(off.bodies).toHaveLength(0)
    expect(dnt.bodies).toHaveLength(0)
  })

  test("maps concrete paths to route templates only", () => {
    expect(routeTemplate("/")).toBe("/")
    expect(routeTemplate("/files")).toBe("/files")
    expect(routeTemplate("/credentials")).toBe("/credentials")
    expect(routeTemplate("/orgs/o1/files/a/b")).toBe("/orgs/:orgId/files/*")
    expect(routeTemplate("/file/~/o1/d1/a/b.md")).toBe("/file/~/:orgId/:driveId/*")
    expect(routeTemplate("/detail/~/o1/d1/x")).toBe("/detail/~/:orgId/:driveId/*")
    expect(routeTemplate("/sql/~/o1/d1")).toBe("/sql/~/:orgId/:driveId")
    expect(routeTemplate("/someone@example.com/private")).toBe("other")
  })
})
