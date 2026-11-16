import type { Drive } from "@/api/types"

export const STAR_REPO_URL = "https://github.com/desplega-ai/agent-fs"
export const STAR_NUDGE_THRESHOLD = 5

/** Older servers omit the summary. Wait for known eligibility without traversing the drive. */
export function hasEnoughFiles(drive: Pick<Drive, "fileCountLowerBound"> | undefined): boolean {
  return (drive?.fileCountLowerBound ?? 0) >= STAR_NUDGE_THRESHOLD
}

export function starNudgeKey(endpoint: string, userId: string, orgId: string, driveId: string): string {
  return `agent-fs:star-nudge:done:${JSON.stringify([endpoint, userId, orgId, driveId])}`
}
