import * as React from "react"

import { cn } from "@/lib/utils"

interface MiddleEllipsisProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string
  /** Reserved for API compatibility; no longer used. */
  trailingChars?: number
}

/**
 * Single-line truncating label. Originally a middle-ellipsis renderer that
 * split the name to preserve a `.md` / `.tsx` extension, but the flex
 * head+tail layout produced a visual gap that read as two separate names in
 * narrow containers (sidebar tree, grid tiles). Plain CSS truncate is more
 * predictable; the full name is exposed via `title=` for native hover and via
 * any wrapping `<Tooltip>`.
 */
export function MiddleEllipsis({
  text,
  trailingChars: _trailingChars,
  className,
  ...props
}: MiddleEllipsisProps) {
  void _trailingChars
  return (
    <span
      className={cn("block min-w-0 truncate", className)}
      title={text}
      {...props}
    >
      {text}
    </span>
  )
}

/**
 * Backwards-compatible export: callers used to read `{ head, tail }`. Now
 * returns the full text as `head` and an empty `tail` so any leftover usage
 * keeps rendering the original text.
 */
export function splitForMiddleEllipsis(
  text: string,
  _trailingChars: number,
): { head: string; tail: string } {
  void _trailingChars
  return { head: text, tail: "" }
}
