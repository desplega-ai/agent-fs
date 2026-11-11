/**
 * Runs `fn` while holding an in-process lock on each (drive, path) pair.
 *
 * Mutating ops check a version, change storage, then record the version, with
 * awaits in between. Without a lock two writers of one path interleave there:
 * both pass the expectedVersion check, or both read the same content to
 * append to. The server is a single process, so an in-memory queue per path is
 * enough to make each op see the previous one's result.
 *
 * shortcut: per process only; two processes on one database are not covered.
 * Upgrade to a storage or database level check if that becomes supported.
 *
 * Keys are taken in sorted order so `mv a b` and `mv b a` cannot deadlock.
 */
const tails = new Map<string, Promise<void>>();

export async function withPathLock<T>(
  driveId: string,
  paths: string[],
  fn: () => Promise<T>
): Promise<T> {
  const keys = [...new Set(paths)].sort().map((p) => `${driveId}\u0000${p}`);
  const releases: Array<() => void> = [];
  try {
    for (const key of keys) {
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prev.then(() => held);
      tails.set(key, tail);
      await prev;
      releases.push(() => {
        release();
        // Drop the entry when nobody queued behind us, so the map stays small.
        if (tails.get(key) === tail) tails.delete(key);
      });
    }
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** Number of paths with a holder or waiter. For tests. */
export function pathLockSize(): number {
  return tails.size;
}
