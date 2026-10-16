export interface UserDirectoryEntry {
  email: string
  displayName: string | null
}

export type UserDirectory = Map<string, UserDirectoryEntry>

interface UserDirectorySource {
  userId: string
  email: string
  displayName?: string | null
}

/**
 * Merge every member list the client can see into one id -> person map.
 * Drive members are readable by any drive member; the org member list is
 * admin-only, so for most users it is absent and must not be required.
 * Later sources only fill gaps, so the first one that knows a name wins.
 */
export function buildUserDirectory(
  sources: ReadonlyArray<ReadonlyArray<UserDirectorySource> | null | undefined>,
): UserDirectory {
  const directory: UserDirectory = new Map()
  for (const source of sources) {
    for (const member of source ?? []) {
      const existing = directory.get(member.userId)
      directory.set(member.userId, {
        email: existing?.email || member.email,
        displayName: existing?.displayName || member.displayName || null,
      })
    }
  }
  return directory
}

function formatEmail(email: string): string {
  const [local, domain] = email.split("@")
  if (local.length > 8) return `${local.slice(0, 3)}...@${domain}`
  return email
}

function formatUserId(userId: string): string {
  if (userId.length > 16 && userId.includes("-")) return userId.slice(0, 8)
  return userId
}

/**
 * The label shown for a person: a name the payload carried, then the
 * member's display name, then their email, then a shortened user id.
 */
export function formatUserDisplay(
  userId: string,
  displayName: string | null | undefined,
  entry: UserDirectoryEntry | null | undefined,
): string {
  const name = displayName?.trim() || entry?.displayName?.trim()
  if (name) return name
  if (entry?.email) return formatEmail(entry.email)
  if (userId.includes("@")) return formatEmail(userId)
  return formatUserId(userId)
}
