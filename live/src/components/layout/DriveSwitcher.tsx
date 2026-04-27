import { HardDrive, Check } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"

export function DriveSwitcher() {
  const { drives, driveId, driveName, setDriveId } = useAuth()
  const { selectFile } = useBrowser()
  const displayName = driveName || driveId.slice(0, 8)

  if (drives.length <= 1) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[10px] px-2 text-xs">
              <HardDrive className="size-3 shrink-0" />
              <span className="hidden sm:inline font-medium text-foreground">{displayName}</span>
              <span className="hidden sm:inline text-[11px] text-muted-foreground">({drives.length})</span>
            </span>
          }
        />
        <TooltipContent side="bottom">{displayName}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="xs" className="gap-1 text-foreground">
                  <HardDrive className="size-3 shrink-0" />
                  <span className="hidden sm:inline font-medium">{displayName}</span>
                  <span className="hidden sm:inline text-[11px] text-muted-foreground">({drives.length})</span>
                </Button>
              }
            />
          }
        />
        <TooltipContent side="bottom">
          {displayName} <span className="text-muted-foreground">({drives.length} drives)</span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {drives.map((drive) => (
          <DropdownMenuItem
            key={drive.id}
            onClick={() => {
              setDriveId(drive.id)
              selectFile(null)
            }}
          >
            <HardDrive className="size-3 text-muted-foreground" />
            <span className="truncate flex-1">{drive.name}</span>
            {drive.id === driveId && <Check className="size-3 text-primary ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
