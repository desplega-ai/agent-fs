import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react"

interface SearchInputContextValue {
  /** Register the input ref so consumers can focus it. */
  register: (el: HTMLInputElement | null) => void
  /** Focus the registered input (no-op if not registered). */
  focus: () => void
  /** Register the opener for the content search modal (fts/semantic/hybrid). */
  registerContentSearch: (open: ((query: string) => void) | null) => void
  /** Open the content search modal seeded with `query` (no-op if not registered). */
  openContentSearch: (query: string) => void
}

const SearchInputContext = createContext<SearchInputContextValue | null>(null)

/**
 * Provider for sharing the sidebar search input ref. The keyboard shortcuts
 * hook uses `focus()` to focus the input on `cmd+k` / `/`.
 */
export function SearchInputProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLInputElement | null>(null)
  const contentSearchRef = useRef<((query: string) => void) | null>(null)

  const register = useCallback((el: HTMLInputElement | null) => {
    ref.current = el
  }, [])

  const focus = useCallback(() => {
    ref.current?.focus()
    // If the input has content, also select it for quick replace.
    if (ref.current && typeof ref.current.select === "function") {
      try {
        ref.current.select()
      } catch {
        // ignore — some inputs don't support select()
      }
    }
  }, [])

  const registerContentSearch = useCallback(
    (open: ((query: string) => void) | null) => {
      contentSearchRef.current = open
    },
    [],
  )

  const openContentSearch = useCallback((query: string) => {
    contentSearchRef.current?.(query)
  }, [])

  const value = useMemo(
    () => ({ register, focus, registerContentSearch, openContentSearch }),
    [register, focus, registerContentSearch, openContentSearch],
  )

  return (
    <SearchInputContext.Provider value={value}>
      {children}
    </SearchInputContext.Provider>
  )
}

/**
 * Returns the search-input context. Returns a no-op fallback if not mounted,
 * so callers (e.g. keyboard shortcuts hook) work in routes without a search bar.
 */
export function useSearchInput(): SearchInputContextValue {
  const ctx = useContext(SearchInputContext)
  if (ctx) return ctx
  return NOOP_CONTEXT
}

const NOOP_CONTEXT: SearchInputContextValue = {
  register: () => {},
  focus: () => {},
  registerContentSearch: () => {},
  openContentSearch: () => {},
}
