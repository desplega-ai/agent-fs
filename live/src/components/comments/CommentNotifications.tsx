import { useState } from "react"
import { Bell, CheckCheck, MessageSquare } from "lucide-react"
import { useBrowser } from "@/contexts/browser"
import {
  useCommentNotifications,
  useMarkCommentNotificationsRead,
} from "@/hooks/use-comment-notifications"
import { useDisplayName } from "@/components/UserName"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { sidePanelStore } from "@/stores/side-panel"
import { uiChromeStore } from "@/stores/ui-chrome"
import type { CommentNotificationEntry } from "@/api/types"

/**
 * Top-bar comment inbox. It deliberately stays absent until the server
 * returns data, which keeps the live UI backward-compatible with older API
 * deployments where the notification ops do not exist yet.
 */
export function CommentNotifications() {
  const [open, setOpen] = useState(false)
  const { selectFile } = useBrowser()
  const { data } = useCommentNotifications()
  const markRead = useMarkCommentNotificationsRead()

  if (!data) return null

  const openNotification = (notification: CommentNotificationEntry) => {
    if (!notification.read) {
      markRead.mutate({ ids: [notification.id] })
    }

    selectFile(notification.path.replace(/^\/+/, ""))
    setOpen(false)

    // The file route updates on this click; wait until the comments rail has
    // committed before asking the shared chrome store to reveal it.
    requestAnimationFrame(() => {
      sidePanelStore.setTab("comments")
      uiChromeStore.setRight(true)
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="relative"
            aria-label={
              data.unreadCount > 0
                ? `${data.unreadCount} unread comment notification${data.unreadCount === 1 ? "" : "s"}`
                : "Comment notifications"
            }
          >
            <Bell />
            {data.unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 flex min-w-3.5 h-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground">
                {data.unreadCount > 99 ? "99+" : data.unreadCount}
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-1rem))] gap-0 overflow-hidden p-0"
      >
        <div className="flex h-10 items-center justify-between border-b border-border px-3">
          <div className="min-w-0">
            <span className="text-sm font-medium">Comments</span>
            {data.unreadCount > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">
                {data.unreadCount} unread
              </span>
            )}
          </div>
          {data.unreadCount > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="gap-1 text-muted-foreground"
              onClick={() => markRead.mutate({ all: true })}
              disabled={markRead.isPending}
            >
              <CheckCheck />
              Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-96 overflow-y-auto p-1.5">
          {data.notifications.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <MessageSquare
                className="size-7 text-muted-foreground/60"
                strokeWidth={1.5}
              />
              <div>
                <p className="text-sm font-medium">No comment activity</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  New comments and replies will appear here.
                </p>
              </div>
            </div>
          ) : (
            data.notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onOpen={openNotification}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function NotificationRow({
  notification,
  onOpen,
}: {
  notification: CommentNotificationEntry
  onOpen: (notification: CommentNotificationEntry) => void
}) {
  const { display } = useDisplayName(notification.actor)

  return (
    <button
      type="button"
      onClick={() => onOpen(notification)}
      className={cn(
        "flex w-full gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        notification.read && "opacity-65",
      )}
    >
      <span
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          notification.read ? "bg-transparent" : "bg-primary",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate text-xs font-medium">{display}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {timeAgo(notification.createdAt)}
          </span>
        </span>
        <span className="mt-0.5 block line-clamp-2 text-xs leading-relaxed">
          {notification.body}
        </span>
        <span className="mt-1 block truncate text-[10px] text-muted-foreground">
          {notification.path.replace(/^\/+/, "")}
        </span>
      </span>
    </button>
  )
}

function timeAgo(dateString: string): string {
  const timestamp = new Date(dateString).getTime()
  if (!Number.isFinite(timestamp)) return ""

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(timestamp).toLocaleDateString()
}
