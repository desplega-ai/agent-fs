import type { Drive, Org } from "@/api/types"

/** Views whose address names an org and a drive. */
export type DriveView = "file" | "detail" | "page" | "sql" | "members" | "shares" | "webhooks"

/** Views whose address continues with a file or folder path. */
const PATH_VIEWS = new Set<DriveView>(["file", "detail", "page"])

export function takesPath(view: DriveView): boolean {
  return PATH_VIEWS.has(view)
}

export interface DriveScopeIds {
  orgId: string
  driveId: string
}

export type NamedDrive = Pick<Drive, "id" | "name">

export interface DriveNames {
  org: string
  drive: string
}

/**
 * Whether a name can stand in the address. `~` marks the ID form, `.` and `..`
 * are dot segments, and the router decodes `%` a second time, so a name with
 * `/` or `%` would not come back as itself.
 */
export function isAddressableName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && name !== "~" && !/[/%]/.test(name)
}

/** A decoded drive path with each segment encoded, without a leading slash. */
export function encodeDrivePath(path: string): string {
  return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")
}

/**
 * The address of `view` for a drive: `/<view>/<org name>/<drive name>` when
 * `names` is given, `/<view>/~/<org id>/<drive id>` otherwise, followed by the
 * encoded `path` on the views that take one.
 */
export function drivePathFor(view: DriveView, ids: DriveScopeIds, names: DriveNames | null, path = ""): string {
  const base = names
    ? `/${view}/${encodeURIComponent(names.org)}/${encodeURIComponent(names.drive)}`
    : `/${view}/~/${ids.orgId}/${ids.driveId}`
  return PATH_VIEWS.has(view) ? `${base}/${encodeDrivePath(path)}` : base
}

/** Members and webhooks also reach drives an admin manages without being on them. */
export function isAdminView(view: DriveView): boolean {
  return view === "members" || view === "webhooks"
}

/** A browsing drive list plus the drives an admin manages but is not on. */
export function withManaged(own: NamedDrive[], managed: NamedDrive[]): NamedDrive[] {
  return [...own, ...managed.filter((d) => !own.some((o) => o.id === d.id))]
}

/** Drive lists by org ID; `undefined` while an org's list is unknown. */
export type DriveLists = (orgId: string) => NamedDrive[] | undefined

/** Every (org, drive) pair named so, among `orgs`. Null while a needed list is unknown. */
export function pairsNamed(orgs: Org[], lists: DriveLists, orgName: string, driveName: string): DriveScopeIds[] | null {
  const pairs: DriveScopeIds[] = []
  for (const org of orgs.filter((o) => o.name === orgName)) {
    const drives = lists(org.id)
    if (!drives) return null
    for (const d of drives) if (d.name === driveName) pairs.push({ orgId: org.id, driveId: d.id })
  }
  return pairs
}

/**
 * The names an address can use for this drive: both addressable, and no other
 * pair the viewer can reach has the same two names. Null otherwise, or while
 * a list it needs is unknown.
 */
export function namesFor(orgs: Org[], lists: DriveLists, ids: DriveScopeIds): DriveNames | null {
  const org = orgs.find((o) => o.id === ids.orgId)
  const drive = lists(ids.orgId)?.find((d) => d.id === ids.driveId)
  if (!org || !drive || !isAddressableName(org.name) || !isAddressableName(drive.name)) return null
  return pairsNamed(orgs, lists, org.name, drive.name)?.length === 1 ? { org: org.name, drive: drive.name } : null
}
