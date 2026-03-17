import { useState, useRef, useEffect } from "react"
import { ChevronDown, Check, HardDrive, Building2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"

export function DrivePicker() {
  const { drives, driveId, driveName, setDriveId, orgName } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const hasMultiple = drives.length > 1

  return (
    <div className="border-b border-sidebar-border px-3 py-2 space-y-1" ref={ref}>
      {/* Org context */}
      <div className="flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground">
        <Building2 className="h-3 w-3 shrink-0" />
        <span className="truncate">{orgName || "Loading..."}</span>
      </div>

      {/* Drive selector / display */}
      <div className="relative">
        {hasMultiple ? (
          <button
            onClick={() => setOpen(!open)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-sidebar-accent transition-colors"
          >
            <HardDrive className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="truncate flex-1 text-left">{driveName || driveId.slice(0, 8)}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        ) : (
          <div className="flex items-center gap-2 px-2 py-1 text-sm">
            <HardDrive className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">{driveName || driveId.slice(0, 8)}</span>
          </div>
        )}

        {open && hasMultiple && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-popover p-1 shadow-md">
            {drives.map((drive) => (
              <button
                key={drive.id}
                onClick={() => {
                  setDriveId(drive.id)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent transition-colors"
              >
                <span className="truncate flex-1 text-left">{drive.name}</span>
                {drive.id === driveId && <Check className="h-3 w-3 text-primary" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
