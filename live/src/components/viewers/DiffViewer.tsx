import { cn } from "@/lib/utils"
import type { DiffChange } from "@/api/types"

interface DiffViewerProps {
  changes: DiffChange[]
  className?: string
}

export function DiffViewer({ changes, className }: DiffViewerProps) {
  // Compute line numbers client-side since backend doesn't populate them
  let oldLine = 0
  let newLine = 0
  const lines = changes.map((change) => {
    const result = { ...change, oldLineNum: 0, newLineNum: 0 }
    switch (change.type) {
      case "context":
        oldLine++
        newLine++
        result.oldLineNum = oldLine
        result.newLineNum = newLine
        break
      case "remove":
        oldLine++
        result.oldLineNum = oldLine
        break
      case "add":
        newLine++
        result.newLineNum = newLine
        break
    }
    return result
  })

  return (
    <div className={cn("overflow-auto font-mono text-xs", className)}>
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            "flex",
            line.type === "add" && "bg-green-500/10",
            line.type === "remove" && "bg-red-500/10"
          )}
        >
          <span className="w-10 shrink-0 select-none text-right pr-1 text-muted-foreground/50">
            {line.oldLineNum || ""}
          </span>
          <span className="w-10 shrink-0 select-none text-right pr-1 text-muted-foreground/50">
            {line.newLineNum || ""}
          </span>
          <span className={cn(
            "w-4 shrink-0 select-none text-center",
            line.type === "add" && "text-green-600 dark:text-green-400",
            line.type === "remove" && "text-red-600 dark:text-red-400"
          )}>
            {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-all pr-4">
            {line.content}
          </span>
        </div>
      ))}
    </div>
  )
}
