import { useCallback, useEffect, useState } from "react"

/**
 * Generic localStorage-backed state hook. Reads the initial value from
 * `localStorage` (falling back to `initial` when absent or invalid) and writes
 * back on every change.
 *
 * Notes:
 * - JSON-serialized; non-serializable values are not supported.
 * - Reads/writes are wrapped in try/catch — quota errors and SSR-style
 *   `localStorage`-undefined environments are silently ignored.
 *
 * Usage:
 *   const [view, setView] = useLocalStorage<"list" | "grid">("liveui:browser:view", "list")
 */
export function useLocalStorage<T>(
  key: string,
  initial: T,
): [T, (value: T) => void] {
  const [value, setValueState] = useState<T>(() => {
    try {
      if (typeof localStorage === "undefined") return initial
      const raw = localStorage.getItem(key)
      if (raw === null) return initial
      return JSON.parse(raw) as T
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      if (typeof localStorage === "undefined") return
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // ignore quota / privacy errors
    }
  }, [key, value])

  const setValue = useCallback((next: T) => {
    setValueState(next)
  }, [])

  return [value, setValue]
}
