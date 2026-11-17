import type { Drive } from "@/api/types"

/** Drives named `name`. Names are unique only within an org, so there can be several. */
export function drivesNamed(drives: Drive[], name: string): Drive[] {
  return drives.filter((d) => d.name === name)
}

/**
 * The link "Copy link" shares. `/d/<drive name>/<path>` when no other drive the
 * viewer can open has that name. The ID form otherwise, while `allDrives` is
 * still unknown (empty), or for a name with "/", which the router can't match.
 */
export function fileLink(origin: string, orgId: string, driveId: string, path: string, allDrives: Drive[]): string {
  const clean = path.replace(/^\/+/, "")
  const drive = allDrives.find((d) => d.id === driveId)
  if (drive && !drive.name.includes("/") && drivesNamed(allDrives, drive.name).length === 1) {
    return `${origin}/d/${encodeURIComponent(drive.name)}/${clean}`
  }
  return `${origin}/file/~/${orgId}/${driveId}/${clean}`
}
