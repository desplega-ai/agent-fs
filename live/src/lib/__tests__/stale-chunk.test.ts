import { describe, expect, test } from "bun:test"
import { RELOAD_GUARD_MS, createStaleChunkReloader, isChunkLoadError } from "../stale-chunk"

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

describe("isChunkLoadError", () => {
  test("matches each browser's failed dynamic import message", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/TextViewer-DDrwghfB.js"))).toBe(true)
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: https://x/assets/a.js"))).toBe(true)
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true)
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true)
  })

  test("ignores other errors", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false)
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

function reloaderAt(now: number, storage: ReturnType<typeof memoryStorage>) {
  const calls = { reloads: 0 }
  const reload = createStaleChunkReloader({ storage: () => storage, now: () => now, reload: () => calls.reloads++ })
  return { reload, calls }
}

describe("createStaleChunkReloader", () => {
  test("reloads once and records when", () => {
    const storage = memoryStorage()
    const { reload, calls } = reloaderAt(1_000_000, storage)
    expect(reload()).toBe(true)
    expect(calls.reloads).toBe(1)
    expect(storage.getItem("agent-fs:stale-chunk-reload-at")).toBe("1000000")
  })

  test("a second failure in the same page reuses the pending reload", () => {
    const { reload, calls } = reloaderAt(1_000_000, memoryStorage())
    reload()
    expect(reload()).toBe(true)
    expect(calls.reloads).toBe(1)
  })

  test("refuses to reload again right after its own reload", () => {
    const storage = memoryStorage({ "agent-fs:stale-chunk-reload-at": "1000000" })
    const { reload, calls } = reloaderAt(1_000_000 + RELOAD_GUARD_MS - 1, storage)
    expect(reload()).toBe(false)
    expect(calls.reloads).toBe(0)
  })

  test("reloads again once the guard window has passed", () => {
    const storage = memoryStorage({ "agent-fs:stale-chunk-reload-at": "1000000" })
    const { reload, calls } = reloaderAt(1_000_000 + RELOAD_GUARD_MS, storage)
    expect(reload()).toBe(true)
    expect(calls.reloads).toBe(1)
  })

  test("never reloads when storage is blocked", () => {
    let reloads = 0
    const reload = createStaleChunkReloader({
      storage: () => {
        throw new Error("SecurityError")
      },
      now: () => 1_000_000,
      reload: () => reloads++,
    })
    expect(reload()).toBe(false)
    expect(reloads).toBe(0)
  })
})
