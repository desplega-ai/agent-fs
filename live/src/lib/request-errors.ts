/**
 * Human copy for failed API requests. The server's raw messages ("Too many
 * requests", "Internal Server Error", "Failed to fetch") describe the transport,
 * not what the user should do next, so map the common classes to an action.
 */

interface ErrorShape {
  error?: unknown
  status?: unknown
  name?: unknown
  message?: unknown
}

function shape(err: unknown): ErrorShape {
  return err && typeof err === "object" ? (err as ErrorShape) : {}
}

/** True for the server's rate limiter (HTTP 429 / `RATE_LIMITED`). */
export function isRateLimitError(err: unknown): boolean {
  const e = shape(err)
  return e.status === 429 || e.error === "RATE_LIMITED"
}

export function describeRequestError(
  err: unknown,
  fallback = "The request failed. Try again.",
): string {
  const e = shape(err)
  const status = typeof e.status === "number" ? e.status : undefined

  if (isRateLimitError(err)) {
    return "The server is busy right now. Wait a few seconds, then retry."
  }
  if (status === 401) return "Your session has expired. Sign in again."
  if (status === 403) return "You don't have access to this drive."
  if (status !== undefined && status >= 500) {
    return "The server hit an error. Retry in a moment."
  }
  // fetch() rejects with a TypeError, and no HTTP status, when the network is down.
  if (status === undefined && e.name === "TypeError") {
    return "Couldn't reach the server. Check your connection, then retry."
  }
  if (typeof e.message === "string" && e.message.trim()) return e.message
  return fallback
}
