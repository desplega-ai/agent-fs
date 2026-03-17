import { useState, useRef, useEffect } from "react"
import { useNavigate } from "react-router"
import { ChevronDown, Plus, Check } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { getCredentials } from "@/stores/credentials"

export function AccountSwitcher() {
  const { credential, switchAccount, user } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const allCredentials = getCredentials()

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  return (
    <div className="relative w-full" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-sidebar-accent transition-colors"
      >
        <div className="flex-1 min-w-0 text-left">
          <p className="font-medium truncate">{credential.name}</p>
          {user && (
            <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
          )}
        </div>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-popover p-1 shadow-md">
          {allCredentials.map((cred) => (
            <button
              key={cred.id}
              onClick={() => {
                switchAccount(cred.id)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <div className="flex-1 min-w-0 text-left">
                <p className="truncate">{cred.name}</p>
                <p className="text-[11px] text-muted-foreground truncate">{cred.endpoint}</p>
              </div>
              {cred.id === credential.id && <Check className="h-3 w-3 text-primary shrink-0" />}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => {
              setOpen(false)
              navigate("/credentials")
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            <Plus className="h-3 w-3" />
            <span>Add account</span>
          </button>
        </div>
      )}
    </div>
  )
}
