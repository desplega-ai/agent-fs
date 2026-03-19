import { useNavigate } from "react-router"
import { ChevronDown, Plus, Check } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { getCredentials } from "@/stores/credentials"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

export function AccountSwitcher() {
  const { credential, switchAccount, user } = useAuth()
  const navigate = useNavigate()
  const allCredentials = getCredentials()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-sidebar-accent transition-colors outline-none">
        <div className="flex-1 min-w-0 text-left">
          <p className="font-medium truncate">{credential.name}</p>
          {user && (
            <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
          )}
        </div>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[var(--anchor-width)]">
        {allCredentials.map((cred) => (
          <DropdownMenuItem
            key={cred.id}
            onClick={() => switchAccount(cred.id)}
          >
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm">{cred.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">{cred.endpoint}</p>
            </div>
            {cred.id === credential.id && <Check className="size-3 text-primary shrink-0 ml-auto" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/credentials")}>
          <Plus className="size-3" />
          <span>Add account</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
