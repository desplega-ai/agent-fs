import { Monitor, Moon, Sun } from "lucide-react"
import { useThemeContext } from "@/contexts/theme"
import type { Theme } from "@/hooks/use-theme"
import { setAutoUpdateDocuments, useAutoUpdateDocuments } from "@/stores/auto-update"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
]

export function UserConfigDialog({ onClose }: { onClose: () => void }) {
  const { theme, setTheme } = useThemeContext()
  const autoUpdate = useAutoUpdateDocuments()

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>User configuration</DialogTitle>
          <DialogDescription>These settings apply to this browser.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span id="user-config-theme">Theme</span>
            <ToggleGroup
              aria-labelledby="user-config-theme"
              value={[theme]}
              onValueChange={(v) => { if (v[0]) setTheme(v[0] as Theme) }}
            >
              {THEMES.map(({ value, label, Icon }) => (
                <ToggleGroupItem key={value} value={value} className="h-7 w-auto gap-1 px-2 text-xs">
                  <Icon />
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <label className="flex items-center justify-between gap-4">
            <span className="grid gap-0.5">
              <span>Auto reload documents</span>
              <span className="text-xs text-muted-foreground">Load a newer version when you are not editing.</span>
            </span>
            <Switch checked={autoUpdate} onCheckedChange={setAutoUpdateDocuments} />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  )
}
