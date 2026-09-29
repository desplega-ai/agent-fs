export const DESKTOP_BREAKPOINT_QUERY = "(min-width: 1024px)"

export function getVisibleCommentSurfaces(isDesktop: boolean, desktopOpen: boolean, mobileOpen: boolean) {
  return {
    desktopOpen: isDesktop && desktopOpen,
    mobileOpen: !isDesktop && mobileOpen,
  }
}

export function subscribeToDesktopBreakpoint(onChange: () => void) {
  const media = window.matchMedia(DESKTOP_BREAKPOINT_QUERY)
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

export function getDesktopBreakpointSnapshot() {
  return window.matchMedia(DESKTOP_BREAKPOINT_QUERY).matches
}
