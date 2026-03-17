import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { FileTreeNode } from "./FileTreeNode"
import type { LsResult } from "@/api/types"

export function FileTree() {
  const { client, orgId, driveId } = useAuth()

  const { data, isLoading, error } = useQuery({
    queryKey: ["ls", orgId, driveId, ""],
    queryFn: () => client.callOp<LsResult>(orgId!, "ls", {}, driveId),
    enabled: !!orgId && !!driveId,
  })

  if (isLoading) {
    return (
      <div className="space-y-1 p-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-7 rounded-sm bg-sidebar-accent/50 animate-pulse" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <p className="p-3 text-sm text-destructive">
        Failed to load files: {(error as Error).message}
      </p>
    )
  }

  if (!data || data.entries.length === 0) {
    return (
      <p className="p-3 text-sm text-muted-foreground">No files yet</p>
    )
  }

  const sorted = [...data.entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <div className="py-1">
      {sorted.map((entry) => (
        <FileTreeNode key={entry.name} entry={entry} path="" depth={0} />
      ))}
    </div>
  )
}
