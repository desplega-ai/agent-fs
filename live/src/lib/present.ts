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
