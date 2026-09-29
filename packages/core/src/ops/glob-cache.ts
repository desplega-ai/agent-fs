import type { S3Object } from "../storage/adapter.js";

const TTL_MS = 3_000;
const MAX_ENTRIES = 100;

interface DriveListing {
  objects: S3Object[];
  prefixes: string[];
}

interface CachedListing {
  orgId: string;
  driveId: string;
  listing: DriveListing;
  expiresAt: number;
}

interface PendingListing {
  orgId: string;
  driveId: string;
  invalidated: boolean;
  promise: Promise<DriveListing>;
}

const cache = new Map<string, CachedListing>();
const pending = new Map<string, PendingListing>();

function listingKey(orgId: string, driveId: string, prefix: string): string {
  return JSON.stringify([orgId, driveId, prefix]);
}

export function getCachedDriveListing(
  orgId: string,
  driveId: string,
  prefix: string,
  load: () => Promise<DriveListing>,
): Promise<DriveListing> {
  const key = listingKey(orgId, driveId, prefix);
  const cached = cache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    // Refresh insertion order so eviction keeps the least recently used entry.
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached.listing);
  }
  if (cached) cache.delete(key);

  const existing = pending.get(key);
  if (existing) return existing.promise;

  let request: PendingListing;
  const promise = Promise.resolve()
    .then(load)
    .then((listing) => {
      if (!request.invalidated) {
        cache.delete(key);
        cache.set(key, {
          orgId,
          driveId,
          listing,
          expiresAt: Date.now() + TTL_MS,
        });
        while (cache.size > MAX_ENTRIES) {
          cache.delete(cache.keys().next().value!);
        }
      }
      return listing;
    })
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });

  request = { orgId, driveId, invalidated: false, promise };
  pending.set(key, request);
  return promise;
}

/** Invalidate cached and in-flight listings after a versioned drive write. */
export function invalidateDriveGlobListings(orgId: string, driveId: string): void {
  for (const [key, entry] of cache) {
    if (entry.orgId === orgId && entry.driveId === driveId) {
      cache.delete(key);
    }
  }

  for (const [key, request] of pending) {
    if (request.orgId === orgId && request.driveId === driveId) {
      request.invalidated = true;
      pending.delete(key);
    }
  }
}
