import { useCallback, useEffect, useState } from "react"

interface ResizableSidebarDefaults {
  open: boolean
  width: number
  min: number
  max: number
}

interface ResizableSidebarState {
  open: boolean
  width: number
  setOpen: (open: boolean) => void
  setWidth: (width: number) => void
  toggle: () => void
  min: number
  max: number
}

interface PersistedShape {
  open?: boolean
  width?: number
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function readPersisted(key: string): PersistedShape | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    return parsed as PersistedShape
  } catch {
    return null
  }
}

function writePersisted(key: string, value: PersistedShape) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota / privacy errors
  }
}

/**
 * Persisted sidebar state hook. Reads/writes a single localStorage key as
 * `{ open, width }`. Width is clamped to `[min, max]` on read and on write.
 *
 * Usage:
 *   const tree = useResizableSidebar("liveui:tree", { open: true, width: 240, min: 180, max: 480 })
 */
export function useResizableSidebar(
  key: string,
  defaults: ResizableSidebarDefaults
): ResizableSidebarState {
  const [open, setOpenState] = useState<boolean>(() => {
    const persisted = readPersisted(key)
    return persisted?.open ?? defaults.open
  })

  const [width, setWidthState] = useState<number>(() => {
    const persisted = readPersisted(key)
    const initial = persisted?.width ?? defaults.width
    return clamp(initial, defaults.min, defaults.max)
  })

  // Persist on change
  useEffect(() => {
    writePersisted(key, { open, width })
  }, [key, open, width])

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
  }, [])

  const setWidth = useCallback(
    (next: number) => {
      setWidthState(clamp(next, defaults.min, defaults.max))
    },
    [defaults.min, defaults.max]
  )

  const toggle = useCallback(() => {
    setOpenState((prev) => !prev)
  }, [])

  return {
    open,
    width,
    setOpen,
    setWidth,
    toggle,
    min: defaults.min,
    max: defaults.max,
  }
}
