import { describe, expect, test } from "bun:test"
import { trackSessionStart, type TelemetryDeps } from "../telemetry"

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
    expect(bodies[0].properties).toEqual({ is_cloud: true })
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
})
