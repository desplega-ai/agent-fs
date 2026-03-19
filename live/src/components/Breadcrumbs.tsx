import { ChevronRight, Building2, HardDrive, Check } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export function Breadcrumbs() {
  const { orgs, orgId, orgName, setOrgId, drives, driveId, driveName, setDriveId } = useAuth()
  const { selectedFile, navigateToFolder, selectFile } = useBrowser()

  const path = selectedFile || ""
  const segments = path ? path.split("/") : []

  return (
    <nav className="flex items-center gap-0.5 text-sm text-muted-foreground min-w-0">
      {/* Org selector */}
      {orgs.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button variant="ghost" size="xs" className="gap-1 text-foreground">
              <Building2 className="size-3.5" />
              <span className="font-medium">{orgName || orgId?.slice(0, 8) || "..."}</span>
              <span className="text-[11px] text-muted-foreground">({orgs.length})</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {orgs.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onClick={() => {
                  setOrgId(org.id)
                  selectFile(null)
                }}
              >
                <Building2 className="size-3 text-muted-foreground" />
                <span className="truncate flex-1">{org.name}</span>
                {org.id === orgId && <Check className="size-3 text-primary ml-auto" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 shrink-0">
          <Building2 className="size-3.5" />
          <span className="font-medium text-foreground">{orgName || orgId?.slice(0, 8) || "..."}</span>
          <span className="text-[11px] text-muted-foreground">({orgs.length})</span>
        </span>
      )}

      <ChevronRight className="size-3 shrink-0" />

      {/* Drive selector */}
      {drives.length > 1 ? (
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
      ) : (
        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 shrink-0">
          <HardDrive className="size-3.5" />
          <span className="font-medium text-foreground">{driveName || driveId.slice(0, 8)}</span>
          <span className="text-[11px] text-muted-foreground">({drives.length})</span>
        </span>
      )}

      {/* File path segments */}
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1
        const segPath = segments.slice(0, i + 1).join("/")
        return (
          <span key={segPath} className="flex items-center gap-0.5 min-w-0">
            <ChevronRight className="size-3 shrink-0" />
            {isLast ? (
              <span className="text-foreground font-medium truncate">{segment}</span>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => navigateToFolder(segPath)}
                className="truncate"
              >
                {segment}
              </Button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
