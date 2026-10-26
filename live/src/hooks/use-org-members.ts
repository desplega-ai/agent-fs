import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { DriveMembersResult, MemberRole } from "@/api/types"
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
  const { orgId, driveId } = useAuth()
  return useDriveMembersOf(orgId, driveId)
}

/** Drives whose members the caller can manage. Empty for someone who admins no drive. */
export function useManageableDrives(orgId: string | null) {
  const { client } = useAuth()

  return useQuery({
    queryKey: ["manageable-drives", orgId],
    queryFn: () => client.getManageableDrives(orgId!),
    enabled: !!orgId,
    retry: false,
  })
}

/**
 * Members of `driveId` with their roles. The endpoint answers 403 to anyone
 * who is neither drive admin nor org admin, which is how the Members page
 * tells an admin from a read-only viewer, so a 403 is not retried.
 */
export function useDriveMembersAdmin(orgId: string | null, driveId: string | null) {
  const { client } = useAuth()

  return useQuery({
    queryKey: ["drive-members", orgId, driveId, "admin"],
    queryFn: () => client.getDriveMembersAdmin(orgId!, driveId!),
    enabled: !!orgId && !!driveId,
    retry: false,
  })
}

/** Members of `driveId` without roles; readable by every member of the drive. */
export function useDriveMembersOf(orgId: string | null, driveId: string | null) {
  const { client } = useAuth()

  return useQuery({
    queryKey: ["drive-members", orgId, driveId],
    queryFn: () => client.callOp<DriveMembersResult>(orgId!, "drive-members", {}, driveId!),
    enabled: !!orgId && !!driveId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

/**
 * Add, re-role and remove members of `driveId`. Every mutation refreshes the
 * drive's member lists, the org list, and the caller's own drive list (a
 * change to your own membership adds or removes a drive in the switcher).
 */
export function useDriveMemberMutations(orgId: string, driveId: string) {
  const { client } = useAuth()
  const queryClient = useQueryClient()
  const onSuccess = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["drive-members", orgId, driveId] }),
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["drives", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["manageable-drives", orgId] }),
    ])

  const add = useMutation({
    mutationFn: (params: { email: string; role: MemberRole }) => client.addDriveMember(orgId, driveId, params),
    onSuccess,
  })
  const updateRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: MemberRole }) =>
      client.updateDriveMemberRole(orgId, driveId, userId, role),
    onSuccess,
  })
  const remove = useMutation({
    mutationFn: (userId: string) => client.removeDriveMember(orgId, driveId, userId),
    onSuccess,
  })
  return { add, updateRole, remove }
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
