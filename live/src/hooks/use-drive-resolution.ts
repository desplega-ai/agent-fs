import { useRef } from "react"
import { useQueries } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { namesFor, pairsNamed, withManaged, type DriveLists, type DriveNames, type DriveScopeIds } from "@/lib/drive-route"
import type { ApiError } from "@/api/client"

export type DriveResolution =
  | { status: "loading" | "failed" | "missing" }
  | { status: "ambiguous"; pairs: DriveScopeIds[] }
  /** `names` is the name form of the address, or null when it must stay by ID. */
  | { status: "ready"; ids: DriveScopeIds; names: DriveNames | null }

export type DriveTarget = { ids: DriveScopeIds } | { names: DriveNames }

/**
 * Drive lists of `orgIds`, under the same query keys the rest of the app uses.
 * With `manageable`, a list also holds the drives an admin manages but is not
 * on. A 403 there means not an admin and adds nothing; any other failure
 * leaves the list unknown, since a drive it would add could share a name.
 */
function useDriveLists(orgIds: string[], manageable: boolean): { lists: DriveLists; failed: boolean } {
  const { client } = useAuth()
  const browse = useQueries({
    queries: orgIds.map((id) => ({ queryKey: ["drives", id], queryFn: () => client.getDrives(id) })),
  })
  const manage = useQueries({
    queries: (manageable ? orgIds : []).map((id) => ({
      queryKey: ["manageable-drives", id],
      queryFn: () => client.getManageableDrives(id),
      retry: false,
    })),
  })
  const notAdmin = (r: (typeof manage)[number]) => (r.error as Partial<ApiError> | null)?.status === 403
  const lists: DriveLists = (id) => {
    const i = orgIds.indexOf(id)
    const own = i < 0 ? undefined : browse[i].data?.drives
    if (!own || !manageable) return own
    const managed = manage[i].data?.drives ?? (notAdmin(manage[i]) ? [] : undefined)
    return managed && withManaged(own, managed)
  }
  // A failed refetch keeps the last list, so only a list that never loaded fails.
  const failed = browse.some((r) => r.isError && !r.data) || manage.some((r) => r.isError && !r.data && !notAdmin(r))
  return { lists, failed }
}

/**
 * Resolves the drive an address names. By ID it is ready at once, with the
 * names to switch the address to once they are known to be unambiguous. By
 * name it waits for the org list and the drive lists of the orgs so named.
 * A list that refetches without data goes back to pending; the last answer
 * for the same address stands meanwhile, so the page stays mounted.
 */
export function useDriveResolution(target: DriveTarget | null, manageable = false): DriveResolution {
  const last = useRef<{ key: string; value: DriveResolution } | null>(null)
  const key = JSON.stringify(target)
  const value = useResolve(target, manageable)
  if (value.status !== "loading") last.current = { key, value }
  else if (last.current?.key === key) return last.current.value
  return value
}

function useResolve(target: DriveTarget | null, manageable: boolean): DriveResolution {
  const { orgs, orgsLoaded, orgsFailed } = useAuth()
  const orgName = !target ? undefined : "names" in target ? target.names.org : orgs.find((o) => o.id === target.ids.orgId)?.name
  const orgIds = orgName === undefined ? [] : orgs.filter((o) => o.name === orgName).map((o) => o.id)
  const { lists, failed } = useDriveLists(orgIds, manageable)

  if (!target) return { status: "missing" }
  if ("ids" in target) return { status: "ready", ids: target.ids, names: namesFor(orgs, lists, target.ids) }
  if (orgsFailed || failed) return { status: "failed" }
  if (!orgsLoaded) return { status: "loading" }
  const pairs = pairsNamed(orgs, lists, target.names.org, target.names.drive)
  if (!pairs) return { status: "loading" }
  if (pairs.length === 0) return { status: "missing" }
  if (pairs.length > 1) return { status: "ambiguous", pairs }
  return { status: "ready", ids: pairs[0], names: target.names }
}
