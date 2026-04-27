import { HardDrive, Check } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export function DriveSwitcher() {
  const { drives, driveId, driveName, setDriveId } = useAuth()
  const { selectFile } = useBrowser()

  if (drives.length <= 1) {
    return (
      <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 shrink-0">
        <HardDrive className="size-3.5" />
        <span className="font-medium text-foreground">{driveName || driveId.slice(0, 8)}</span>
        <span className="text-[11px] text-muted-foreground">({drives.length})</span>
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button variant="ghost" size="xs" className="gap-1 text-foreground">
          <HardDrive className="size-3.5" />
          <span className="font-medium">{driveName || driveId.slice(0, 8)}</span>
          <span className="text-[11px] text-muted-foreground">({drives.length})</span>
        </Button>
      </DropdownMenuTrigger>
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
