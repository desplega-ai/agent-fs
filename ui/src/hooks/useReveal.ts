import { useEffect, useRef } from "react"

export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible")
            // Also reveal staggered children
            entry.target.querySelectorAll(".reveal").forEach((child) => {
              child.classList.add("visible")
            })
            observer.unobserve(entry.target)
          }
        }
      },
      { threshold: 0.15 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return ref
}
