import { describe, expect, test } from "bun:test"
import {
  createStarNudge,
  STAR_NUDGE_COUNT_KEY,
  STAR_NUDGE_DONE_KEY,
  STAR_NUDGE_THRESHOLD,
} from "../star-nudge"

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

function setup(storage = memoryStorage()) {
  const shows: Array<() => void> = []
  const nudge = createStarNudge({ storage, show: (onDone) => shows.push(onDone) })
  return { storage, shows, nudge }
}

describe("star nudge", () => {
  test("shows on the 5th write action, not before", () => {
    const { shows, nudge } = setup()
    for (let i = 1; i < STAR_NUDGE_THRESHOLD; i++) {
      expect(nudge.recordWriteAction()).toBe(false)
    }
    expect(shows).toHaveLength(0)
    expect(nudge.recordWriteAction()).toBe(true)
    expect(shows).toHaveLength(1)
  })

  test("shows only once per page while it is open", () => {
    const { shows, nudge } = setup()
    for (let i = 0; i < STAR_NUDGE_THRESHOLD + 3; i++) nudge.recordWriteAction()
    expect(shows).toHaveLength(1)
  })

  test("counts across page loads through storage", () => {
    const storage = memoryStorage()
    const first = setup(storage)
    for (let i = 1; i < STAR_NUDGE_THRESHOLD; i++) first.nudge.recordWriteAction()
    expect(first.shows).toHaveLength(0)
    const second = setup(storage)
    expect(second.nudge.recordWriteAction()).toBe(true)
    expect(second.shows).toHaveLength(1)
  })

  test("never shows again after close or click", () => {
    const storage = memoryStorage()
    const first = setup(storage)
    for (let i = 0; i < STAR_NUDGE_THRESHOLD; i++) first.nudge.recordWriteAction()
    first.shows[0]!()
    expect(storage.data.get(STAR_NUDGE_DONE_KEY)).toBe("1")

    const second = setup(storage)
    for (let i = 0; i < STAR_NUDGE_THRESHOLD * 2; i++) {
      expect(second.nudge.recordWriteAction()).toBe(false)
    }
    expect(second.shows).toHaveLength(0)
  })

  test("comes back after a reload when it was never closed", () => {
    const storage = memoryStorage()
    const first = setup(storage)
    for (let i = 0; i < STAR_NUDGE_THRESHOLD; i++) first.nudge.recordWriteAction()
    const second = setup(storage)
    expect(second.nudge.recordWriteAction()).toBe(true)
  })

  test("treats a corrupt count as zero", () => {
    const { shows, nudge } = setup(memoryStorage({ [STAR_NUDGE_COUNT_KEY]: "nope" }))
    for (let i = 1; i < STAR_NUDGE_THRESHOLD; i++) nudge.recordWriteAction()
    expect(shows).toHaveLength(0)
    nudge.recordWriteAction()
    expect(shows).toHaveLength(1)
  })

  test("does nothing without storage or when storage throws", () => {
    const shows: Array<() => void> = []
    const none = createStarNudge({ storage: null, show: (d) => shows.push(d) })
    const throwing = createStarNudge({
      storage: {
        getItem: () => {
          throw new Error("blocked")
        },
        setItem: () => {
          throw new Error("blocked")
        },
      },
      show: (d) => shows.push(d),
    })
    for (let i = 0; i < STAR_NUDGE_THRESHOLD * 2; i++) {
      none.recordWriteAction()
      throwing.recordWriteAction()
    }
    expect(shows).toHaveLength(0)
  })
})
