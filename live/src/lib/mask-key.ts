/**
 * Mask an API key for display, e.g. `af_1234abcd…f3a2`.
 *
 * Keeps the first 6 characters and the last 4 characters separated by an
 * em-ellipsis (…). For very short inputs (length < 12) returns the input
 * unchanged so we never display something more recognizable than the original.
 *
 * Examples:
 *   maskApiKey("af_a1b2c3d4e5f6...f3a2") => "af_a1b2…f3a2"
 *   maskApiKey("af_short") => "af_short"
 *   maskApiKey("") => ""
 */
export function maskApiKey(key: string): string {
  if (!key) return ""
  if (key.length < 12) return key
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
