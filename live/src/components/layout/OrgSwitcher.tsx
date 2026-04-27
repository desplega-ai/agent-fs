import { Building2, Check } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export function OrgSwitcher() {
  const { orgs, orgId, orgName, setOrgId } = useAuth()
  const { selectFile } = useBrowser()

  if (orgs.length <= 1) {
    return (
      <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[10px] px-2 text-xs">
        <Building2 className="size-3" />
        <span className="font-medium text-foreground">{orgName || orgId?.slice(0, 8) || "..."}</span>
        <span className="text-[11px] text-muted-foreground">({orgs.length})</span>
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button variant="ghost" size="xs" className="gap-1 text-foreground">
          <Building2 className="size-3" />
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
  )
}
