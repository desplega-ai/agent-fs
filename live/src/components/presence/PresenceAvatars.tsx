import { UserAvatar } from "@/components/UserAvatar"
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { presenceName } from "@/lib/presence"
import { presenceStore, useDocPresence, usePresenceEnabled, usePresenceSettings } from "@/stores/presence"
import { toast } from "@/stores/toast"
import type { PresenceSession } from "@/api/types"

const MAX_SHOWN = 3

function activity(s: PresenceSession): string {
  return s.mode === "edit" ? "editing" : "viewing"
}

/**
 * Who else has this doc open: an avatar stack (3 + "+N") for the doc header.
 * Clicking it opens the list (a row scrolls to that person's pointer or
 * selection) and the See cursors / See selections toggles. Renders nothing
 * when presence is off or nobody else is here.
 */
export function PresenceAvatars({ path }: { path: string }) {
  const enabled = usePresenceEnabled()
  const users = useDocPresence(path)
  const settings = usePresenceSettings()
  if (!enabled || !users.length) return null

  const shown = users.slice(0, MAX_SHOWN)
  const extra = users.length - shown.length
  const count = `${users.length} ${users.length === 1 ? "other person" : "other people"} on this file`

  const reveal = (s: PresenceSession) => {
    if (!presenceStore.reveal(s.userId)) toast(`${presenceName(s)} has no cursor or selection in view`)
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={count}
            data-presence-avatars
            className="mr-1 flex items-center -space-x-1.5 rounded-full p-0.5 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        {shown.map((s) => (
          <Tooltip key={s.userId}>
            <TooltipTrigger render={<span className="rounded-full ring-2 ring-background" />}>
              <UserAvatar userId={s.userId} displayName={presenceName(s)} className="size-6 text-[11px]" />
            </TooltipTrigger>
            <TooltipContent>
              {presenceName(s)} <span className="opacity-60">{activity(s)}</span>
            </TooltipContent>
          </Tooltip>
        ))}
        {extra > 0 && (
          <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background">
            +{extra}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle>On this file</PopoverTitle>
        </PopoverHeader>
        <ul className="-mx-1 flex flex-col">
          {users.map((s) => (
            <li key={s.userId}>
              <button
                type="button"
                onClick={() => reveal(s)}
                aria-label={`Go to ${presenceName(s)}, ${activity(s)}`}
                className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted"
              >
                <UserAvatar userId={s.userId} displayName={presenceName(s)} />
                <span className="min-w-0 flex-1 truncate">{presenceName(s)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{activity(s)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2 border-t border-border pt-2.5">
          <label className="flex items-center justify-between gap-2">
            <span>See cursors</span>
            <Switch
              size="sm"
              checked={settings.showCursors}
              onCheckedChange={(checked) => presenceStore.setSettings({ showCursors: checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>See selections</span>
            <Switch
              size="sm"
              checked={settings.showSelections}
              onCheckedChange={(checked) => presenceStore.setSettings({ showSelections: checked })}
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  )
}
