import { useNavigate } from "react-router"
import { HardDrive, Check, Users, Webhook } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { useManageableDrives } from "@/hooks/use-org-members"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { toast } from "@/stores/toast"

export function DriveSwitcher() {
  const { drives, driveId, driveName, setDriveId, orgId } = useAuth()
  const { setSelectedFile } = useBrowser()
  const navigate = useNavigate()
  const displayName = driveName || driveId.slice(0, 8)
  const single = drives.length <= 1
  // Webhooks are for drive admins and org admins. The server enforces that;
  // hiding the entry only keeps everyone else away from a page that 403s.
  const { data: manageable } = useManageableDrives(orgId)
  const canManageWebhooks = !!manageable?.drives.some((d) => d.id === driveId)

  // A one-drive org still opens the menu: it carries the Members entry.
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button data-drive-switcher variant="ghost" size="sm" className="gap-1 text-foreground">
                  <HardDrive className="size-3.5 shrink-0" />
                  <span className="hidden sm:inline-block max-w-48 truncate font-medium text-sm">{displayName}</span>
                  <span className="hidden sm:inline text-xs text-muted-foreground">({drives.length})</span>
                </Button>
              }
            />
          }
        />
        <TooltipContent side="bottom">
          {displayName}
          {!single && <span className="text-muted-foreground"> ({drives.length} drives)</span>}
          <Kbd className="ml-1">⇧D</Kbd>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {drives.map((drive) => (
          <DropdownMenuItem
            key={drive.id}
            onClick={() => {
              if (drive.id === driveId) return
              setDriveId(drive.id)
              setSelectedFile(null)
              toast(`Switched to ${drive.name}`)
              navigate(orgId ? `/file/~/${orgId}/${drive.id}/` : "/files")
            }}
          >
            <HardDrive className="size-3 text-muted-foreground" />
            <span className="truncate flex-1" title={drive.name}>{drive.name}</span>
            {drive.id === driveId && <Check className="size-3 text-primary ml-auto" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!orgId || !driveId}
          onClick={() => navigate(`/members/~/${orgId}/${driveId}`)}
        >
          <Users className="size-3 text-muted-foreground" />
          <span className="flex-1">Members</span>
          <DropdownMenuShortcut>⇧M</DropdownMenuShortcut>
        </DropdownMenuItem>
        {canManageWebhooks && (
          <DropdownMenuItem onClick={() => navigate(`/webhooks/~/${orgId}/${driveId}`)}>
            <Webhook className="size-3 text-muted-foreground" />
            <span className="flex-1">Webhooks</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
