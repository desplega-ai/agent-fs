/**
 * Caches minted signed URLs for markdown drive images, scoped per-client so
 * switching accounts (a different backend/credential) never reuses a
 * still-valid signed URL minted for the previous account.
 */

export interface DriveImageResolution {
  orgId: string
  driveId: string
  path: string
}

export interface DriveImageCacheEntry {
  url: string
  /** Epoch ms; `Infinity` for a non-expiring entry. */
  expiresAt: number
  /**
   * `url` is an object URL this cache owns. It is revoked once it is replaced
   * or deleted and no longer held, or after `IDLE_EVICT_MS` with no holder.
   */
  objectUrl?: boolean
}

export const MIN_FRESH_MS = 5 * 60 * 1000

/** An owned object URL nobody holds is evicted after this long, so its blob does not outlive the page that showed it. */
export const IDLE_EVICT_MS = MIN_FRESH_MS

type CacheValue = DriveImageCacheEntry | Promise<DriveImageCacheEntry>

export class DriveImageCache {
  private entries = new Map<string, CacheValue>()
  private holds = new Map<string, number>()
  private retired = new Set<string>()
  private idle = new Map<string, ReturnType<typeof setTimeout>>()

  /** A mounted image is showing `url`; an owned object URL stays alive until every holder releases it. */
  hold(url: string): void {
    this.cancelIdle(url)
    this.holds.set(url, (this.holds.get(url) ?? 0) + 1)
  }

  release(url: string): void {
    const count = (this.holds.get(url) ?? 0) - 1
    if (count > 0) {
      this.holds.set(url, count)
      return
    }
    this.holds.delete(url)
    if (this.retired.delete(url)) URL.revokeObjectURL(url)
    else this.scheduleIdle(url)
  }

  /** Evicts a still-cached owned object URL once it has gone `IDLE_EVICT_MS` without a holder. */
  private scheduleIdle(url: string): void {
    if (!this.ownerKey(url)) return
    this.cancelIdle(url)
    this.idle.set(url, setTimeout(() => {
      this.idle.delete(url)
      const key = this.ownerKey(url)
      if (!key || this.holds.has(url)) return
      this.entries.delete(key)
      URL.revokeObjectURL(url)
    }, IDLE_EVICT_MS))
  }

  private cancelIdle(url: string): void {
    clearTimeout(this.idle.get(url))
    this.idle.delete(url)
  }

  /** The key whose settled entry is the owned object URL `url`. */
  private ownerKey(url: string): string | undefined {
    for (const [key, value] of this.entries) {
      if (!(value instanceof Promise) && value.objectUrl && value.url === url) return key
    }
    return undefined
  }

  /** Revokes an owned object URL that left the cache, now or when its last holder releases it. */
  private retire(previous: CacheValue | undefined, next?: CacheValue): void {
    if (!previous || previous instanceof Promise || !previous.objectUrl) return
    if (next && !(next instanceof Promise) && next.url === previous.url) return
    this.cancelIdle(previous.url)
    if (this.holds.has(previous.url)) this.retired.add(previous.url)
    else URL.revokeObjectURL(previous.url)
  }

  private key(clientId: string, res: DriveImageResolution): string {
    return `${clientId}::${res.orgId}/${res.driveId}/${res.path}`
  }

  get(clientId: string, res: DriveImageResolution): CacheValue | undefined {
    return this.entries.get(this.key(clientId, res))
  }

  /** Returns the cached entry only if it's settled (not pending) and has enough life left. */
  getFresh(clientId: string, res: DriveImageResolution): DriveImageCacheEntry | null {
    const cached = this.entries.get(this.key(clientId, res))
    if (cached && !(cached instanceof Promise) && cached.expiresAt - Date.now() > MIN_FRESH_MS) {
      return cached
    }
    return null
  }

  set(clientId: string, res: DriveImageResolution, value: CacheValue): void {
    const key = this.key(clientId, res)
    this.retire(this.entries.get(key), value)
    this.entries.set(key, value)
    // A minted image whose viewer unmounted before it settled is never held.
    if (!(value instanceof Promise) && !this.holds.has(value.url)) this.scheduleIdle(value.url)
  }

  delete(clientId: string, res: DriveImageResolution): void {
    const key = this.key(clientId, res)
    this.retire(this.entries.get(key))
    this.entries.delete(key)
  }
}

export const driveImageCache = new DriveImageCache()
