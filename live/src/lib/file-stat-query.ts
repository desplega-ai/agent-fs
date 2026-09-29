import type { AgentFsClient } from "@/api/client"
import type { StatResult } from "@/api/types"

export function fileStatQueryKey(orgId: string | null, driveId: string | null, path: string | null) {
  return ["stat", orgId, driveId, path] as const
}

export function fetchFileStat(client: AgentFsClient, orgId: string, driveId: string, path: string) {
  return client.callOp<StatResult>(orgId, "stat", { path }, driveId)
}
