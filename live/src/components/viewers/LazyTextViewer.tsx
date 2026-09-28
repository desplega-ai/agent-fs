import { Suspense, lazy, type ComponentProps } from "react"
import { cn } from "@/lib/utils"

// TextViewer is the only viewer that mounts the Monaco editor (read-only code
// view and every edit mode). Loading it on demand keeps Monaco and its loader
// out of the entry bundle, so opening a rendered markdown file never pays for
// them.
const TextViewer = lazy(() => import("./TextViewer").then((m) => ({ default: m.TextViewer })))

type TextViewerProps = ComponentProps<typeof TextViewer>

const SKELETON_LINE_WIDTHS = ["w-2/5", "w-3/5", "w-1/2", "w-4/5", "w-1/3", "w-2/3", "w-1/2", "w-3/4"]

/** Code-shaped placeholder shown while the editor chunk loads. */
function TextViewerSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2.5 overflow-hidden p-4", className)} role="status" aria-label="Loading editor">
      {SKELETON_LINE_WIDTHS.map((width, i) => (
        <div key={i} className={cn("h-3 shrink-0 rounded-sm bg-muted animate-pulse", width)} />
      ))}
    </div>
  )
}

export function LazyTextViewer(props: TextViewerProps) {
  return (
    <Suspense fallback={<TextViewerSkeleton className={props.className} />}>
      <TextViewer {...props} />
    </Suspense>
  )
}
