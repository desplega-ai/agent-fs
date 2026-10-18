/**
 * Server-sent events frame parser for streams read with `fetch` (the live UI
 * cannot use `EventSource`: it sends no Authorization header). Frames end at a
 * blank line. `event:` names the frame (default "message"), `data:` lines are
 * joined with "\n", and `:` lines are comments (the server's `: ping`).
 */

export interface SseFrame {
  event: string
  data: string
}

export interface SseHandlers {
  onFrame: (frame: SseFrame) => void
  /** A comment line, without the leading ":" (e.g. " ping"). */
  onComment?: (text: string) => void
}

/** Returns a function to feed decoded text chunks; frames may span chunks. */
export function createSseParser({ onFrame, onComment }: SseHandlers): (chunk: string) => void {
  let buffer = ""
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, "\n")
    let end: number
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = ""
      const data: string[] = []
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) {
          onComment?.(line.slice(1))
          continue
        }
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? "" : line.slice(colon + 1)
        if (value.startsWith(" ")) value = value.slice(1)
        if (field === "event") event = value
        else if (field === "data") data.push(value)
      }
      if (event || data.length) onFrame({ event: event || "message", data: data.join("\n") })
    }
  }
}
