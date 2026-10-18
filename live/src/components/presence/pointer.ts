/** Arrow cursor drawn for a remote mouse pointer, tip at (1, 1) of a 12 x 17 box. */
export const POINTER_PATH = "M1 1 L1 14 L4.5 10.8 L7 16 L9 15.1 L6.6 10 L11 10 Z"

/**
 * DOM for a remote pointer outside React (a Monaco content widget): the arrow
 * plus a name tag, styled by `.presence-pointer` in index.css.
 */
export function createPointerNode(): HTMLElement {
  const node = document.createElement("div")
  node.className = "presence-pointer"
  node.setAttribute("aria-hidden", "true")
  node.innerHTML = `<svg width="12" height="17" viewBox="0 0 12 17"><path d="${POINTER_PATH}" stroke="white" stroke-width="1" /></svg><span class="presence-tag"></span>`
  return node
}

export function paintPointerNode(node: HTMLElement, color: string, name: string) {
  node.querySelector("path")?.setAttribute("fill", color)
  const tag = node.querySelector<HTMLElement>(".presence-tag")
  if (!tag) return
  tag.textContent = name
  tag.style.background = color
}
