import type { LsResult } from "@/api/types"

export const STAR_REPO_URL = "https://github.com/desplega-ai/agent-fs"
export const STAR_NUDGE_THRESHOLD = 5

/** Stop as soon as the drive has enough files. */
export async function hasEnoughFiles(list: (path: string) => Promise<LsResult>): Promise<boolean> {
  const pending = ["/"]
  let count = 0
  while (pending.length) {
    const path = pending.pop()!
    const { entries } = await list(path)
    for (const entry of entries) {
      if (entry.type === "file") {
        if (++count >= STAR_NUDGE_THRESHOLD) return true
      } else if (entry.type === "directory") {
        pending.push(`${path.replace(/\/$/, "")}/${entry.name}/`)
      }
    }
  }
  return false
}

export function starNudgeKey(endpoint: string, userId: string, orgId: string, driveId: string): string {
  return `agent-fs:star-nudge:done:${JSON.stringify([endpoint, userId, orgId, driveId])}`
}
