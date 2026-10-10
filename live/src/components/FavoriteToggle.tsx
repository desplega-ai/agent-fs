import { Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useFavorites } from "@/hooks/use-favorites"
import { starToggleHandlers } from "@/lib/favorites"
import { cn } from "@/lib/utils"

interface FavoriteToggleProps {
  favorited: boolean
  onToggle: () => void
  /** What the star is on, for the accessible name: "notes.md". */
  name: string
  className?: string
  tabIndex?: number
  /** Header buttons get a tooltip; dense rows rely on the title attribute. */
  withTooltip?: boolean
}

/**
 * Star button. Clicking or pressing Enter/Space only toggles the star: the
 * handlers stop the event before it can reach a row or link that opens the
 * file, so starring never navigates.
 */
export function FavoriteToggle({
  favorited,
  onToggle,
  name,
  className,
  tabIndex,
  withTooltip = false,
}: FavoriteToggleProps) {
  const label = favorited ? `Remove ${name} from favorites` : `Add ${name} to favorites`
  const button = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-pressed={favorited}
      aria-label={label}
      title={withTooltip ? undefined : label}
      tabIndex={tabIndex}
      data-favorite-toggle=""
      className={cn(
        favorited ? "text-amber-500 hover:text-amber-600" : "text-muted-foreground",
        className,
      )}
      {...starToggleHandlers(onToggle)}
    >
      <Star className={cn(favorited && "fill-current")} />
    </Button>
  )
  if (!withTooltip) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{favorited ? "Remove from favorites" : "Add to favorites"}</TooltipContent>
    </Tooltip>
  )
}

/** Star for an open file's header. Hidden on servers without favorites. */
export function FileFavoriteButton({ path }: { path: string }) {
  const { supported, isFavorite, toggleFavorite } = useFavorites()
  if (!supported) return null
  return (
    <FavoriteToggle
      favorited={isFavorite(path)}
      onToggle={() => toggleFavorite(path, "file")}
      name={path.split("/").pop() ?? path}
      withTooltip
    />
  )
}
