import { Building2, Check } from "lucide-react"
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
import { Kbd } from "@/components/ui/kbd"
import { toast } from "@/stores/toast"

export function OrgSwitcher() {
  const { orgs, orgId, orgName, setOrgId } = useAuth()
  const { selectFile } = useBrowser()
  const displayName = orgName || orgId?.slice(0, 8) || "..."

  if (orgs.length <= 1) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[10px] px-2 text-sm">
              <Building2 className="size-3.5 shrink-0" />
              <span className="hidden sm:inline-block max-w-48 truncate font-medium text-foreground">{displayName}</span>
              <span className="hidden sm:inline text-xs text-muted-foreground">({orgs.length})</span>
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
                <Button data-org-switcher variant="ghost" size="sm" className="gap-1 text-foreground">
                  <Building2 className="size-3.5 shrink-0" />
                  <span className="hidden sm:inline-block max-w-48 truncate font-medium text-sm">{displayName}</span>
                  <span className="hidden sm:inline text-xs text-muted-foreground">({orgs.length})</span>
                </Button>
              }
            />
          }
        />
        <TooltipContent side="bottom">
          {displayName} <span className="text-muted-foreground">({orgs.length} orgs)</span>
          <Kbd className="ml-1">⇧G</Kbd>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => {
              if (org.id === orgId) return
              setOrgId(org.id)
              selectFile(null)
              toast(`Switched to ${org.name}`)
            }}
          >
            <Building2 className="size-3 text-muted-foreground" />
            <span className="truncate flex-1" title={org.name}>{org.name}</span>
            {org.id === orgId && <Check className="size-3 text-primary ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
