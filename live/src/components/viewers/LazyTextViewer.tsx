import { Suspense, lazy, type ComponentProps } from "react"
import { TextViewerSkeleton } from "./TextViewerSkeleton"

// TextViewer is the only viewer that mounts the Monaco editor (read-only code
// view and every edit mode). Loading it on demand keeps Monaco and its loader
// out of the entry bundle, so opening a rendered markdown file never pays for
// them.
const TextViewer = lazy(() => import("./TextViewer").then((m) => ({ default: m.TextViewer })))

type TextViewerProps = ComponentProps<typeof TextViewer>

export function LazyTextViewer(props: TextViewerProps) {
  return (
    <Suspense fallback={<TextViewerSkeleton className={props.className} />}>
      <TextViewer {...props} />
    </Suspense>
  )
}
