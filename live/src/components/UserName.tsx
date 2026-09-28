import { Mail, Hash } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { useUserResolver } from "@/hooks/use-org-members"

function formatDisplay(author: string): string {
  if (author.includes("@")) {
    const [local, domain] = author.split("@")
    if (local.length > 8) return `${local.slice(0, 3)}...@${domain}`
    return author
  }
  if (author.length > 16 && author.includes("-")) return author.slice(0, 8)
  return author
}

interface UserNameProps {
  userId: string
  displayName?: string
  className?: string
}

export function UserName({ userId, displayName, className }: UserNameProps) {
  const resolve = useUserResolver()
  const email = resolve(userId)
  const display = displayName || formatDisplay(email ?? userId)

  return (
    <Tooltip>
      <TooltipTrigger>
        <span className={className ?? "text-xs font-medium truncate cursor-default"}>
          {display}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="p-0">
        <div className="flex flex-col gap-0.5 px-3 py-2 text-xs">
          {email && (
            <span className="flex items-center gap-1.5">
              <Mail className="size-3 opacity-60" />
              {email}
            </span>
          )}
          <span className="flex items-center gap-1.5 opacity-60 font-mono text-[10px]">
            <Hash className="size-3" />
            {userId.slice(0, 8)}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export function useDisplayName(userId: string, displayName?: string): { display: string; email: string | null } {
  const resolve = useUserResolver()
  const email = resolve(userId)
  const display = displayName || formatDisplay(email ?? userId)
  return { display, email }
}
