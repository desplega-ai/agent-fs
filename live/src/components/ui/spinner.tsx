import { cn } from "@/lib/utils"

interface SpinnerProps {
  className?: string
  size?: "sm" | "md" | "lg"
}

const sizeClasses = {
  sm: "size-4 border-[1.5px]",
  md: "size-6 border-2",
  lg: "size-8 border-2",
}

export function Spinner({ className, size = "md" }: SpinnerProps) {
  return (
    <div
      className={cn(
        "animate-spin rounded-full border-muted-foreground/30 border-t-muted-foreground",
        sizeClasses[size],
        className
      )}
    />
  )
}
