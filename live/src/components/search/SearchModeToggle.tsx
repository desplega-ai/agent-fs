import { cn } from "@/lib/utils"

export type SearchMode = "files" | "fulltext" | "semantic"

interface SearchModeToggleProps {
  mode: SearchMode
  onChange: (mode: SearchMode) => void
  semanticDisabled?: boolean
}

const modes: { value: SearchMode; label: string }[] = [
  { value: "files", label: "Files" },
  { value: "fulltext", label: "Full-text" },
  { value: "semantic", label: "Semantic" },
]

export function SearchModeToggle({ mode, onChange, semanticDisabled }: SearchModeToggleProps) {
  return (
    <div className="flex rounded-md border border-border text-xs">
      {modes.map((m) => {
        const disabled = m.value === "semantic" && semanticDisabled
        return (
          <button
            key={m.value}
            onClick={() => !disabled && onChange(m.value)}
            disabled={disabled}
            className={cn(
              "flex-1 px-2 py-1 transition-colors first:rounded-l-md last:rounded-r-md",
              mode === m.value
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent",
              disabled && "opacity-40 cursor-not-allowed"
            )}
            title={disabled ? "No embedding provider configured" : undefined}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}
