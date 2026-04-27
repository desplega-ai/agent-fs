import { useNavigate } from "react-router"
import { ChevronDown, Plus, Check, User } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { getCredentials } from "@/stores/credentials"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export function AccountSwitcher() {
  const { credential, switchAccount, user } = useAuth()
  const navigate = useNavigate()
  const allCredentials = getCredentials()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button variant="ghost" size="xs" className="gap-1 text-foreground max-w-[10rem]">
          <User className="size-3.5 text-muted-foreground" />
          <span className="font-medium truncate">{credential.name}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[14rem]">
        {user && (
          <>
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground truncate">{user.email}</div>
            <DropdownMenuSeparator />
          </>
        )}
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
