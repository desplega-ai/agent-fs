/**
 * Process-wide flag for a one-time schema upgrade that holds SQLite's write
 * lock for minutes (today: the content_chunks index build in a helper
 * process). While it is set, the HTTP layer answers writes with 503 instead of
 * letting them time out on SQLITE_BUSY, and /health reports the reason.
 */
let reason: string | null = null;

export function setUpgradeInProgress(r: string): void {
  reason = r;
}

export function clearUpgradeInProgress(): void {
  reason = null;
}

export function upgradeInProgress(): string | null {
  return reason;
}
