import { afterEach, expect, test } from "bun:test"
import {
  DESKTOP_BREAKPOINT_QUERY,
  getDesktopBreakpointSnapshot,
  getVisibleCommentSurfaces,
  subscribeToDesktopBreakpoint,
} from "../desktop-breakpoint"

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

test("desktop comment visibility follows the active media query after resize", () => {
  let matches = false
  const listeners = new Set<() => void>()
  const media = {
    get matches() { return matches },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  } as unknown as MediaQueryList
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: (query: string) => {
      expect(query).toBe(DESKTOP_BREAKPOINT_QUERY)
      return media
    } },
  })

  let changes = 0
  const unsubscribe = subscribeToDesktopBreakpoint(() => { changes++ })
  expect(getDesktopBreakpointSnapshot()).toBe(false)
  expect(getVisibleCommentSurfaces(false, true, false)).toEqual({ desktopOpen: false, mobileOpen: false })

  matches = true
  for (const listener of listeners) listener()
  expect(changes).toBe(1)
  expect(getDesktopBreakpointSnapshot()).toBe(true)
  expect(getVisibleCommentSurfaces(true, false, true)).toEqual({ desktopOpen: false, mobileOpen: false })
  expect(getVisibleCommentSurfaces(true, true, false)).toEqual({ desktopOpen: true, mobileOpen: false })

  matches = false
  for (const listener of listeners) listener()
  expect(changes).toBe(2)
  expect(getVisibleCommentSurfaces(false, true, false)).toEqual({ desktopOpen: false, mobileOpen: false })
  unsubscribe()
  expect(listeners.size).toBe(0)
})
