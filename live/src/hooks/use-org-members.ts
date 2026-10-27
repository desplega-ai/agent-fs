import { useMemo } from "react"
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { AgentFsClient } from "@/api/client"
import type { DriveGrant, DriveMembersResult, MemberRole } from "@/api/types"
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

const orgMembersKey = (orgId: string) => ["org-members", orgId] as const

/**
 * The org member list for deciding something about a person (invite vs add):
 * always refetched on mount, never served from the 5 minute cache. Callers
 * check `isSuccess && !isFetching` before acting on it.
 */
export function useFreshOrgMembers(orgId: string) {
  const { client } = useAuth()

  return useQuery({
    queryKey: orgMembersKey(orgId),
    queryFn: () => client.getOrgMembers(orgId),
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  })
}

/** The org member list as it is right now. Rejects when the lookup fails, so callers never act on a guess. */
export function fetchFreshOrgMembers(queryClient: QueryClient, client: AgentFsClient, orgId: string) {
  return queryClient.fetchQuery({
    queryKey: orgMembersKey(orgId),
    queryFn: () => client.getOrgMembers(orgId),
    staleTime: 0,
  })
}

/**
 * Roles of `userId` on each of `driveIds`, read fresh from the drives' admin
 * member lists (the caller manages every drive passed in). `roles[driveId]` is
 * the role, `null` when they are not on the drive, and absent until that list
 * has loaded; `failed` lists drives whose lookup errored.
 */
export function useDriveRolesOf(orgId: string, driveIds: string[], userId: string | undefined) {
  const { client } = useAuth()
  const results = useQueries({
    queries: driveIds.map((driveId) => ({
      queryKey: ["drive-members", orgId, driveId, "admin"],
      queryFn: () => client.getDriveMembersAdmin(orgId, driveId),
      enabled: !!userId,
      staleTime: 0,
      refetchOnMount: "always" as const,
      retry: false,
    })),
  })
  const roles: Record<string, MemberRole | null> = {}
  const failed: string[] = []
  driveIds.forEach((driveId, i) => {
    const r = results[i]
    if (r.isError) failed.push(driveId)
    else if (r.isSuccess && !r.isFetching) roles[driveId] = r.data.members.find((m) => m.userId === userId)?.role ?? null
  })
  return { roles, failed }
}

/** Roles of `userId` on `driveIds` as they are right now. Rejects when any lookup fails. */
export async function fetchFreshDriveRoles(
  queryClient: QueryClient,
  client: AgentFsClient,
  orgId: string,
  driveIds: string[],
  userId: string,
): Promise<Record<string, MemberRole | undefined>> {
  const lists = await Promise.all(
    driveIds.map((driveId) =>
      queryClient.fetchQuery({
        queryKey: ["drive-members", orgId, driveId, "admin"],
        queryFn: () => client.getDriveMembersAdmin(orgId, driveId),
        staleTime: 0,
      }),
    ),
  )
  return Object.fromEntries(driveIds.map((driveId, i) => [driveId, lists[i].members.find((m) => m.userId === userId)?.role]))
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

/**
 * Whether the caller is an admin of the active org, read from the org list the
 * app already loads, so asking costs no request (the org member list answers
 * 403 to everyone else).
 */
export function useIsOrgAdmin(): boolean {
  const { orgs, orgId } = useAuth()
  return orgs.find((o) => o.id === orgId)?.role === "admin"
}

/** Open invites of `orgId`. Pass `enabled: false` for callers who are not org admins. */
export function usePendingInvites(orgId: string | null, enabled: boolean) {
  const { client } = useAuth()

  return useQuery({
    queryKey: ["invites", orgId],
    queryFn: () => client.getInvites(orgId!),
    enabled: enabled && !!orgId,
    retry: false,
  })
}

/**
 * Invite someone, add an existing org member to drives, and revoke pending
 * invites. Each refreshes the lists an invite can change: the open invites,
 * the org and drive member lists, and the caller's own drives.
 */
export function useInviteMutations(orgId: string) {
  const { client } = useAuth()
  const queryClient = useQueryClient()
  const onSuccess = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["invites", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["drive-members", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["drives", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["manageable-drives", orgId] }),
    ])

  const invite = useMutation({
    mutationFn: (params: { email: string; role: MemberRole; drives: DriveGrant[] }) =>
      client.inviteToOrg(orgId, params),
    onSuccess,
  })
  const addToDrive = useMutation({
    mutationFn: ({ driveId, ...params }: { driveId: string; email: string; role: MemberRole }) =>
      client.addDriveMember(orgId, driveId, params),
    onSuccess,
  })
  const revoke = useMutation({
    mutationFn: (inviteId: string) => client.revokeInvite(orgId, inviteId),
    onSuccess,
  })
  return { invite, addToDrive, revoke }
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
