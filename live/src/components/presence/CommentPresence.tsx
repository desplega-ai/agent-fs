import { useMemo } from "react"
import { UserAvatar } from "@/components/UserAvatar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { presenceName } from "@/lib/presence"
import { useDocPresence } from "@/stores/presence"

/** Other people on the comment thread `commentId` (hovering, focusing or replying to it). */
function useThreadPresence(path: string, commentId: string) {
  const users = useDocPresence(path)
  return useMemo(() => users.filter((s) => s.commentId === commentId), [users, commentId])
}

/** Small avatars of the people looking at this thread. */
export function CommentViewers({ path, commentId }: { path: string; commentId: string }) {
  const users = useThreadPresence(path, commentId)
  if (!users.length) return null
  const label = users.map((s) => `${presenceName(s)} is ${s.commentState === "replying" ? "replying" : "viewing"}`).join(", ")
  return (
    <span role="img" aria-label={label} data-comment-viewers className="mr-1 flex items-center -space-x-1">
      {users.map((s) => (
        <Tooltip key={s.userId}>
          <TooltipTrigger render={<span className="rounded-full ring-2 ring-background" />}>
            <UserAvatar userId={s.userId} displayName={presenceName(s)} className="size-4 text-[9px]" />
          </TooltipTrigger>
          <TooltipContent>
            {presenceName(s)} is {s.commentState === "replying" ? "replying" : "viewing"}
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  )
}

/** "Name is replying..." under a thread while someone has its reply box focused. */
export function CommentReplying({ path, commentId }: { path: string; commentId: string }) {
  const users = useThreadPresence(path, commentId)
  const names = users.filter((s) => s.commentState === "replying").map(presenceName)
  if (!names.length) return null
  const text = names.length === 1
    ? `${names[0]} is replying...`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are replying...`
  return (
    <p role="status" className="mt-1.5 text-[11px] italic text-muted-foreground">
      {text}
    </p>
  )
}
