import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Folder, FolderOpen, File, ChevronRight, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import type { LsEntry, LsResult } from "@/api/types"

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return <File className="h-4 w-4 text-blue-500" />
    case "md":
    case "mdx":
      return <File className="h-4 w-4 text-emerald-500" />
    case "json":
    case "yaml":
    case "yml":
    case "toml":
      return <File className="h-4 w-4 text-amber-500" />
    case "css":
    case "scss":
      return <File className="h-4 w-4 text-purple-500" />
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return <File className="h-4 w-4 text-pink-500" />
    default:
      return <File className="h-4 w-4 text-muted-foreground" />
  }
}

interface FileTreeNodeProps {
  entry: LsEntry
  path: string
  depth: number
}

export function FileTreeNode({ entry, path, depth }: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const { client, orgId, driveId } = useAuth()
  const { selectedFile, selectFile } = useBrowser()
  const fullPath = path ? `${path}/${entry.name}` : entry.name
  const isDir = entry.type === "directory"
  const isSelected = selectedFile === fullPath

  const { data: children } = useQuery({
    queryKey: ["ls", orgId, driveId, fullPath],
    queryFn: () =>
      client.callOp<LsResult>(orgId!, "ls", { path: fullPath }, driveId),
    enabled: isDir && expanded && !!driveId,
  })

  const handleClick = () => {
    if (isDir) {
      setExpanded(!expanded)
    } else {
      selectFile(fullPath)
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-sm hover:bg-sidebar-accent transition-colors",
          isSelected && "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDir ? (
          <>
            {expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            {expanded ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <Folder className="h-4 w-4 shrink-0 text-amber-500" />
            )}
          </>
        ) : (
          <>
            <span className="w-3" />
            {fileIcon(entry.name)}
          </>
        )}
        <span className="truncate">{entry.name}</span>
      </button>

      {isDir && expanded && children && (
        <div>
          {children.entries
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "directory" ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .map((child) => (
              <FileTreeNode
                key={child.name}
                entry={child}
                path={fullPath}
                depth={depth + 1}
              />
            ))}
          {children.entries.length === 0 && (
            <p
              className="px-2 py-1 text-xs text-muted-foreground italic"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              Empty folder
            </p>
          )}
        </div>
      )}
    </div>
  )
}
