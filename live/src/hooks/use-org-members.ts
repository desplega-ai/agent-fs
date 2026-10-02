import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { DriveMembersResult } from "@/api/types"
import { buildUserDirectory, type UserDirectoryEntry } from "@/lib/user-display"

export function useOrgMembers() {
  const { client, orgId } = useAuth()

  return useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => client.getOrgMembers(orgId!),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  })
}

/** Members of the active drive. Unlike the org list, every drive member can read it. */
export function useDriveMembers() {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["drive-members", orgId, driveId],
    queryFn: () =>
      client.callOp<DriveMembersResult>(orgId!, "drive-members", {}, driveId),
    enabled: !!orgId && !!driveId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function useUserResolver(): (userId: string) => UserDirectoryEntry | null {
  const { data: driveMembers } = useDriveMembers()
  const { data: orgMembers } = useOrgMembers()
  const { user } = useAuth()

  const directory = useMemo(
    () =>
      buildUserDirectory([
        user ? [user] : [],
        driveMembers?.members,
        orgMembers?.members,
      ]),
    [user, driveMembers?.members, orgMembers?.members],
  )

  return (userId: string) => directory.get(userId) ?? null
}
