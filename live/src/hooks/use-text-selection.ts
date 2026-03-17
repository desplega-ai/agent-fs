import { useEffect, useState, useCallback } from "react"

interface TextSelection {
  text: string
  lineStart: number
  lineEnd: number
  rect: DOMRect
}

export function useTextSelection(containerRef: React.RefObject<HTMLElement | null>) {
  const [selection, setSelection] = useState<TextSelection | null>(null)

  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setSelection(null)
      return
    }

    const range = sel.getRangeAt(0)
    const container = containerRef.current
    if (!container || !container.contains(range.startContainer)) {
      setSelection(null)
      return
    }

    const text = sel.toString().trim()
    if (!text) {
      setSelection(null)
      return
    }

    // Calculate line numbers from the DOM position
    const lineStart = getLineNumber(range.startContainer, container)
    const lineEnd = getLineNumber(range.endContainer, container)

    const rect = range.getBoundingClientRect()
    setSelection({ text, lineStart, lineEnd, rect })
  }, [containerRef])

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange)
    return () => document.removeEventListener("selectionchange", handleSelectionChange)
  }, [handleSelectionChange])

  const clear = useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }, [])

  return { selection, clearSelection: clear }
}

function getLineNumber(node: Node, container: HTMLElement): number {
  // Walk up to find the line span element, then count preceding line spans
  let el = node instanceof HTMLElement ? node : node.parentElement
  while (el && el !== container) {
    // Shiki renders each line as a span.line
    if (el.tagName === "SPAN" && el.classList.contains("line")) {
      const allLines = container.querySelectorAll("span.line")
      const idx = Array.from(allLines).indexOf(el)
      return idx >= 0 ? idx + 1 : 1
    }
    el = el.parentElement
  }
  // Fallback: estimate from vertical position
  return 1
}
