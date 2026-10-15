import { describe, expect, jest, spyOn, test } from "bun:test"
import { DriveImageCache, IDLE_EVICT_MS, type DriveImageResolution } from "../drive-image-cache"

const RES: DriveImageResolution = {
  orgId: "4fdbb8e2-f63b-4977-95be-6e18019f0e86",
  driveId: "99d03b30-1ffd-4ddd-b332-1244b511b230",
  path: "docs/logo.png",
}

const FRESH_ENTRY = { url: "https://signed.example.com/a", expiresAt: Date.now() + 60 * 60 * 1000 }

describe("DriveImageCache", () => {
  test("entries are scoped per client id, even for the identical org/drive/path", () => {
    const cache = new DriveImageCache()
    cache.set("client-a", RES, FRESH_ENTRY)

    expect(cache.getFresh("client-a", RES)).toEqual(FRESH_ENTRY)
    expect(cache.getFresh("client-b", RES)).toBeNull()
  })

  test("switching client id does not reuse the prior account's still-valid signed URL", () => {
    const cache = new DriveImageCache()
    cache.set("account-1", RES, FRESH_ENTRY)

    // Switching accounts must mint fresh, not silently hand back account-1's URL.
    expect(cache.get("account-2", RES)).toBeUndefined()
    expect(cache.getFresh("account-2", RES)).toBeNull()
  })

  test("delete only clears the entry for the given client id", () => {
    const cache = new DriveImageCache()
    cache.set("client-a", RES, FRESH_ENTRY)
    cache.set("client-b", RES, FRESH_ENTRY)

    cache.delete("client-a", RES)

    expect(cache.getFresh("client-a", RES)).toBeNull()
    expect(cache.getFresh("client-b", RES)).toEqual(FRESH_ENTRY)
  })

  test("an entry close to expiry is not considered fresh", () => {
    const cache = new DriveImageCache()
    cache.set("client-a", RES, { url: "https://signed.example.com/b", expiresAt: Date.now() + 1000 })

    expect(cache.getFresh("client-a", RES)).toBeNull()
  })

  const owned = (url: string) => ({ url, expiresAt: Date.now() + 60 * 60 * 1000, objectUrl: true })

  function withRevokeSpy(run: (revoked: string[]) => void) {
    const revoked: string[] = []
    const spy = spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => void revoked.push(url))
    try {
      run(revoked)
    } finally {
      spy.mockRestore()
    }
  }

  test("delete revokes an unheld object URL the cache owns, never a signed URL", () => {
    withRevokeSpy((revoked) => {
      const cache = new DriveImageCache()
      cache.set("client-a", RES, owned("blob:owned"))
      cache.set("client-b", RES, FRESH_ENTRY)

      cache.delete("client-a", RES)
      cache.delete("client-b", RES)

      expect(revoked).toEqual(["blob:owned"])
    })
  })

  test("replacing an unheld object URL revokes it; re-setting the same URL does not", () => {
    withRevokeSpy((revoked) => {
      const cache = new DriveImageCache()
      cache.set("client-a", RES, owned("blob:old"))
      cache.set("client-a", RES, owned("blob:old"))
      expect(revoked).toEqual([])

      cache.set("client-a", RES, owned("blob:new"))
      expect(revoked).toEqual(["blob:old"])
    })
  })

  test("a replaced object URL stays alive until its last holder releases it", () => {
    withRevokeSpy((revoked) => {
      const cache = new DriveImageCache()
      cache.set("client-a", RES, owned("blob:old"))
      cache.hold("blob:old")
      cache.hold("blob:old")

      cache.set("client-a", RES, Promise.resolve(owned("blob:new")))
      cache.release("blob:old")
      expect(revoked).toEqual([])

      cache.release("blob:old")
      expect(revoked).toEqual(["blob:old"])
    })
  })

  function withFakeTimers(run: () => void) {
    jest.useFakeTimers()
    try {
      run()
    } finally {
      jest.useRealTimers()
    }
  }

  test("releasing a URL that is still cached keeps it until the idle delay", () => {
    withFakeTimers(() => withRevokeSpy((revoked) => {
      const cache = new DriveImageCache()
      cache.set("client-a", RES, owned("blob:live"))
      cache.hold("blob:live")
      cache.release("blob:live")

      jest.advanceTimersByTime(IDLE_EVICT_MS - 1)
      expect(revoked).toEqual([])
      expect(cache.getFresh("client-a", RES)?.url).toBe("blob:live")
    }))
  })

  test("an owned URL with no holder past the idle delay is evicted and revoked once", () => {
    withFakeTimers(() => withRevokeSpy((revoked) => {
      const cache = new DriveImageCache()
      cache.set("client-a", RES, owned("blob:idle"))
      cache.hold("blob:idle")
      cache.release("blob:idle")

      jest.advanceTimersByTime(IDLE_EVICT_MS + 1)
      expect(revoked).toEqual(["blob:idle"])
      expect(cache.getFresh("client-a", RES)).toBeNull()
      expect(cache.get("client-a", RES)).toBeUndefined()

      jest.advanceTimersByTime(IDLE_EVICT_MS * 2)
      expect(revoked).toEqual(["blob:idle"])
    }))
  })

  test("re-holding before the idle delay keeps the URL", () => {
    withFakeTimers(() => withRevokeSpy((revoked) => {
      const cache = new DriveImageCache()
      cache.set("client-a", RES, owned("blob:back"))
      cache.hold("blob:back")
      cache.release("blob:back")

      jest.advanceTimersByTime(IDLE_EVICT_MS - 1)
      cache.hold("blob:back")
      jest.advanceTimersByTime(IDLE_EVICT_MS * 2)

      expect(revoked).toEqual([])
      expect(cache.getFresh("client-a", RES)?.url).toBe("blob:back")
    }))
  })

  test("an owned URL that settles after its viewer unmounted is evicted without ever being held", () => {
    withFakeTimers(() => withRevokeSpy((revoked) => {
      const cache = new DriveImageCache()
      cache.set("client-a", RES, owned("blob:orphan"))

      jest.advanceTimersByTime(IDLE_EVICT_MS + 1)
      expect(revoked).toEqual(["blob:orphan"])
      expect(cache.get("client-a", RES)).toBeUndefined()
    }))
  })

  test("a URL replaced before the idle delay is revoked once, and its timer leaves the new entry alone", () => {
    withFakeTimers(() => withRevokeSpy((revoked) => {
      const cache = new DriveImageCache()
      cache.set("client-a", RES, owned("blob:first"))
      cache.hold("blob:first")
      cache.release("blob:first")
      cache.set("client-a", RES, owned("blob:second"))
      cache.hold("blob:second")
      expect(revoked).toEqual(["blob:first"])

      jest.advanceTimersByTime(IDLE_EVICT_MS * 2)
      expect(revoked).toEqual(["blob:first"])
      expect(cache.getFresh("client-a", RES)?.url).toBe("blob:second")
    }))
  })

  test("signed URLs are never evicted on idle", () => {
    withFakeTimers(() => withRevokeSpy((revoked) => {
      const cache = new DriveImageCache()
      cache.set("client-a", RES, FRESH_ENTRY)
      cache.hold(FRESH_ENTRY.url)
      cache.release(FRESH_ENTRY.url)

      jest.advanceTimersByTime(IDLE_EVICT_MS * 2)
      expect(revoked).toEqual([])
      expect(cache.get("client-a", RES)).toEqual(FRESH_ENTRY)
    }))
  })
})
