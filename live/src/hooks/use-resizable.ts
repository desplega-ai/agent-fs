import { useState, useCallback, useRef } from "react"

export function useResizable(defaultWidth: number, minWidth: number, maxWidth: number) {
  const [width, setWidth] = useState(defaultWidth)
  const dragging = useRef(false)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = width

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = startX - ev.clientX // inverted: drag left = wider
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta))
      setWidth(newWidth)
    }

    const onMouseUp = () => {
      dragging.current = false
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }

    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }, [width, minWidth, maxWidth])

  return { width, onMouseDown }
}
