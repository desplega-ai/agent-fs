import { useEffect } from "react"
import { Link, useParams } from "react-router"
import { ArrowLeft } from "lucide-react"
import { HtmlViewer } from "@/components/viewers/HtmlViewer"
import { Spinner } from "@/components/ui/spinner"
import { useAuth } from "@/contexts/auth"
import { useHealth } from "@/hooks/use-health"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { isHtmlPath, supportsHtmlSites } from "@/lib/html-view"
import { exitFullscreen } from "@/lib/present"

export function PresentPage() {
  const params = useParams()
  const { orgId, driveId } = useAuth()
  const { data: health, isLoading } = useHealth()

  const filePath = params["*"] ?? ""
  // Per segment, so a `#` or `?` in a name stays part of the path.
  const fileUrl = `/file/~/${params.orgId}/${params.driveId}/${filePath.split("/").map(encodeURIComponent).join("/")}`
  useDocumentTitle(filePath.split("/").pop() || null)
  // Present took the browser full screen; leaving the page gives it back.
  useEffect(() => exitFullscreen, [])

  const backLink = (
    <Link
      to={fileUrl}
      className="fixed bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground opacity-60 shadow-sm transition-opacity hover:opacity-100 focus-visible:opacity-100"
    >
      <ArrowLeft className="size-3" />
      Back to file
    </Link>
  )

  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!isHtmlPath(filePath) || !supportsHtmlSites(health)) {
    return (
      <div className="flex h-dvh items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Only HTML pages can be presented.
        {backLink}
      </div>
    )
  }

  return (
    <>
      {/* Per drive too, as in FileViewer: the drive-root confirm must not carry over. */}
      <HtmlViewer key={`${orgId}/${driveId}/${filePath}`} path={filePath} className="h-dvh w-full" />
      {backLink}
    </>
  )
}
