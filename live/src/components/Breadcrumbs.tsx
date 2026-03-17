import { useState, useRef, useEffect } from "react"
import { ChevronRight, Building2, HardDrive, Check } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"

function Dropdown({ children, trigger }: { children: React.ReactNode; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground transition-colors"
      >
        {trigger}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-md"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function Breadcrumbs() {
  const { orgs, orgId, orgName, setOrgId, drives, driveId, driveName, setDriveId } = useAuth()
  const { selectedFile, navigateToFolder, selectFile } = useBrowser()

  const path = selectedFile || ""
  const segments = path ? path.split("/") : []

  return (
    <nav className="flex items-center gap-0.5 text-sm text-muted-foreground min-w-0">
      {/* Org selector */}
      {orgs.length > 1 ? (
        <Dropdown
          trigger={
            <>
              <Building2 className="h-3.5 w-3.5" />
              <span className="font-medium text-foreground">{orgName || orgId?.slice(0, 8) || "..."}</span>
              <span className="text-[11px] text-muted-foreground">({orgs.length})</span>
            </>
          }
        >
          {orgs.map((org) => (
            <button
              key={org.id}
              onClick={() => {
                setOrgId(org.id)
                selectFile(null)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate flex-1 text-left">{org.name}</span>
              {org.id === orgId && <Check className="h-3 w-3 text-primary shrink-0" />}
            </button>
          ))}
        </Dropdown>
      ) : (
        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 shrink-0">
          <Building2 className="h-3.5 w-3.5" />
          <span className="font-medium text-foreground">{orgName || orgId?.slice(0, 8) || "..."}</span>
          <span className="text-[11px] text-muted-foreground">({orgs.length})</span>
        </span>
      )}

      <ChevronRight className="h-3 w-3 shrink-0" />

      {/* Drive selector */}
      {drives.length > 1 ? (
        <Dropdown
          trigger={
            <>
              <HardDrive className="h-3.5 w-3.5" />
              <span className="font-medium text-foreground">{driveName || driveId.slice(0, 8)}</span>
              <span className="text-[11px] text-muted-foreground">({drives.length})</span>
            </>
          }
        >
          {drives.map((drive) => (
            <button
              key={drive.id}
              onClick={() => {
                setDriveId(drive.id)
                selectFile(null)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <HardDrive className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate flex-1 text-left">{drive.name}</span>
              {drive.id === driveId && <Check className="h-3 w-3 text-primary shrink-0" />}
            </button>
          ))}
        </Dropdown>
      ) : (
        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 shrink-0">
          <HardDrive className="h-3.5 w-3.5" />
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
            <ChevronRight className="h-3 w-3 shrink-0" />
            {isLast ? (
              <span className="text-foreground font-medium truncate">{segment}</span>
            ) : (
              <button
                onClick={() => navigateToFolder(segPath)}
                className="rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground transition-colors truncate"
              >
                {segment}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
