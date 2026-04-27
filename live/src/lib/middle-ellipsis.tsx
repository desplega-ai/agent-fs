import * as React from "react"

import { cn } from "@/lib/utils"

interface MiddleEllipsisProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string
  /**
   * Number of trailing characters to keep visible when no extension can be
   * detected. Defaults to 8 (matches the Phase 3 plan spec).
   */
  trailingChars?: number
}

/**
 * Middle-ellipsis renderer that preserves the file extension (or the last
 * `trailingChars` characters when no extension is present).
 *
 * Pure CSS — no JS measurement. The leading span flex-grows and ellipsises
 * via `text-overflow: ellipsis`; the trailing span has `flex-shrink: 0` so
 * the suffix is always visible.
 */
export function MiddleEllipsis({
  text,
  trailingChars = 8,
  className,
  ...props
}: MiddleEllipsisProps) {
  const { head, tail } = splitForMiddleEllipsis(text, trailingChars)

  return (
    <span
      className={cn("flex min-w-0 items-baseline", className)}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{head}</span>
      {tail.length > 0 ? (
        <span className="flex-shrink-0 whitespace-pre">{tail}</span>
      ) : null}
    </span>
  )
}

export function splitForMiddleEllipsis(
  text: string,
  trailingChars: number,
): { head: string; tail: string } {
  if (text.length <= trailingChars) {
    return { head: text, tail: "" }
  }

  // Prefer to keep the file extension in the trailing span, e.g. ".md".
  // We deliberately ignore leading dots ("dotfiles" like `.env`).
  const lastDot = text.lastIndexOf(".")
  if (lastDot > 0 && lastDot < text.length - 1) {
    const ext = text.slice(lastDot)
    if (ext.length <= 8) {
      // Reasonable extension length — use it as the tail.
      return { head: text.slice(0, lastDot), tail: ext }
    }
  }

  return {
    head: text.slice(0, text.length - trailingChars),
    tail: text.slice(text.length - trailingChars),
  }
}
