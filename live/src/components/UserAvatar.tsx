import { useDisplayName } from "@/components/UserName"
import { userColor } from "@/lib/presence"
import { cn } from "@/lib/utils"

interface UserAvatarProps {
  userId: string
  /** Name the payload carried (comment author, presence session). */
  displayName?: string
  className?: string
}

/**
 * A person's initial on their color. The color is the same one their presence
 * cursors and selections use, so a comment avatar matches its author's cursor.
 * Size and ring come from `className` (default: 20 px).
 */
export function UserAvatar({ userId, displayName, className }: UserAvatarProps) {
  const { display } = useDisplayName(userId, displayName)
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 select-none items-center justify-center rounded-full text-[10px] font-medium text-white",
        className,
      )}
      style={{ backgroundColor: userColor(userId) }}
    >
      {display.charAt(0).toUpperCase()}
    </span>
  )
}
