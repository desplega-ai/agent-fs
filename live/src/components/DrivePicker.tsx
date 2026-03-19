import { ChevronDown, Check, HardDrive, Building2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"

export function DrivePicker() {
  const { drives, driveId, driveName, setDriveId, orgName } = useAuth()
  const hasMultiple = drives.length > 1

  return (
    <div className="border-b border-sidebar-border px-3 py-2 space-y-1">
      {/* Org context */}
      <div className="flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground">
        <Building2 className="size-3 shrink-0" />
        <span className="truncate">{orgName || "Loading..."}</span>
      </div>

      {/* Drive selector / display */}
      {hasMultiple ? (
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-sidebar-accent transition-colors outline-none">
            <HardDrive className="size-3.5 text-muted-foreground shrink-0" />
            <span className="truncate flex-1 text-left">{driveName || driveId.slice(0, 8)}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[var(--anchor-width)]">
            {drives.map((drive) => (
              <DropdownMenuItem
                key={drive.id}
                onClick={() => setDriveId(drive.id)}
              >
                <span className="truncate flex-1">{drive.name}</span>
                {drive.id === driveId && <Check className="size-3 text-primary ml-auto" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex items-center gap-2 px-2 py-1 text-sm">
          <HardDrive className="size-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{driveName || driveId.slice(0, 8)}</span>
        </div>
      )}
    </div>
  )
}
