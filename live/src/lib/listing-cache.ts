import type { QueryClient } from "@tanstack/react-query"
import { ancestorListings } from "./paths"

/**
 * Cache invalidation for structural file changes (create, upload, rename,
 * delete). Folder listings are cached per path under
 * `["ls", orgId, driveId, folder]`; file metadata under
 * `["stat", orgId, driveId, path]`. Only mounted queries refetch, so
 * invalidating the whole root-to-parent chain is cheap and keeps every
 * expanded tree node and the open folder view consistent.
 */
function invalidateListings(
  queryClient: QueryClient,
  orgId: string,
  driveId: string,
  folders: string[],
): void {
  for (const folder of new Set(folders)) {
    void queryClient.invalidateQueries({
      queryKey: ["ls", orgId, driveId, folder],
      exact: true,
    })
  }
}

/** Invalidate every listing that may show `path` plus the file's own stat. */
export function invalidateForPath(
  queryClient: QueryClient,
  orgId: string,
  driveId: string,
  path: string,
): void {
  invalidateListings(queryClient, orgId, driveId, ancestorListings(path))
  void queryClient.invalidateQueries({
    queryKey: ["stat", orgId, driveId, path],
    exact: true,
  })
  // The drive-root "Recent activity" strip lists the latest versions.
  void queryClient.invalidateQueries({ queryKey: ["recent", orgId, driveId] })
}
