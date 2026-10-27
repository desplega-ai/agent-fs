import { describe, expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { invitesAvailable } from "@/lib/invites"

// Lives outside src/lib/ on purpose: the root `bun run test` only has the root
// install, which has no React Query. Run it from live/ with `pnpm test:invites`.
describe("invitesAvailable against a real query", () => {
  const health = { ok: true, version: "1", features: ["drive-invites", "pending-invites"] }

  test("follows a real query through a held refresh, a failed one and a recovery", async () => {
    const client = new QueryClient()
    let release!: (value: typeof health) => void
    let next: Promise<typeof health> = Promise.resolve(health)
    const observer = new QueryObserver(client, { queryKey: ["health"], queryFn: () => next, staleTime: 0, retry: false })
    const unsubscribe = observer.subscribe(() => {})
    const available = () => invitesAvailable(observer.getCurrentResult())

    await observer.refetch()
    expect(available()).toBe(true)

    // Hold the refresh pending: cached data is still there, isSuccess is still true.
    next = new Promise((resolve) => (release = resolve))
    const held = observer.refetch()
    const during = observer.getCurrentResult()
    expect(during.isSuccess).toBe(true)
    expect(during.data).toEqual(health)
    expect(available()).toBe(false)
    release(health)
    await held
    expect(available()).toBe(true)

    next = Promise.reject(new Error("down"))
    await observer.refetch()
    expect(available()).toBe(false)

    next = Promise.resolve(health)
    await observer.refetch()
    expect(available()).toBe(true)
    unsubscribe()
    client.clear()
  })
})
