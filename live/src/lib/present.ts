import { isHtmlPath, supportsHtmlSites } from "@/lib/html-view"
import type { HealthResponse } from "@/lib/upload-limit"

/** Files `MarkdownViewer` renders (as in `FileViewer`). */
export function isMarkdownPath(path: string): boolean {
  const name = path.split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
  return ext === "md" || ext === "mdx" || ext === "txt"
}

/** What the presented page can show: Markdown, and HTML on a server with `html-sites`. */
export function canPresent(path: string, health?: HealthResponse): boolean {
  return isMarkdownPath(path) || (isHtmlPath(path) && supportsHtmlSites(health))
}

/** The route that shows a file on its own, without the app chrome. */
export function presentUrl(orgId: string, driveId: string, path: string): string {
  // Per segment, so a `#` or `?` in a name stays part of the path.
  return `/page/~/${orgId}/${driveId}/${path.split("/").map(encodeURIComponent).join("/")}`
}

/**
 * Takes the browser full screen. Must run from the click or key that asked for
 * it, so the navigation that follows keeps the user's activation. A browser
 * that refuses (iOS Safari, an embedded view) still shows the page.
 */
export function enterFullscreen(): void {
  const root = document.documentElement
  if (document.fullscreenElement || typeof root.requestFullscreen !== "function") return
  root.requestFullscreen().catch(() => {})
}

export function exitFullscreen(): void {
  if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
    document.exitFullscreen().catch(() => {})
  }
}
