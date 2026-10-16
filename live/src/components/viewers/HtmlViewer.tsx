import { useEffect, useState } from "react"
import { Globe } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { approveRootHtml, folderOf, isRootHtmlApproved, resolveHtmlViewUrl } from "@/lib/html-view"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Never add `allow-same-origin`: the page must get an opaque origin, so it
// cannot read this app's localStorage (which holds the API key).
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"

/** The iframe URL of an HTML file, served from a short-lived site share of its folder. */
function useHtmlViewUrl(path: string, enabled: boolean, reloadKey: number) {
  const { client, orgId, driveId } = useAuth()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !orgId || !driveId) {
      setUrl(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    resolveHtmlViewUrl(client, orgId, driveId, path).then((next) => {
      if (!cancelled) {
        setUrl(next)
        setIsLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        setError((err as Error).message)
        setIsLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [path, orgId, driveId, client, enabled, reloadKey])

  return { url, error, isLoading }
}

interface HtmlViewerProps {
  path: string
  className?: string
  /** Changes after a save, so the frame reloads with the new content. */
  reloadKey?: number
  onShowSource: () => void
}

export function HtmlViewer({ path, className, reloadKey = 0, onShowSource }: HtmlViewerProps) {
  const { orgId, driveId } = useAuth()
  // A file at the drive root gets a share of the whole drive, so ask first.
  const atRoot = folderOf(path) === "/"
  const [confirmed, setConfirmed] = useState(() => !atRoot || (!!orgId && !!driveId && isRootHtmlApproved(orgId, driveId, path)))
  const { url, error, isLoading } = useHtmlViewUrl(path, confirmed, reloadKey)

  if (!confirmed) {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-4 p-8 text-center", className)}>
        <Globe className="h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm max-w-sm">
          This page can read every file in this drive for 15 minutes while it is open. Render it?
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              if (orgId && driveId) approveRootHtml(orgId, driveId, path)
              setConfirmed(true)
            }}
          >
            Render
          </Button>
          <Button size="sm" variant="outline" onClick={onShowSource}>
            Show source
          </Button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn("flex items-center justify-center p-8 text-sm text-destructive", className)}>
        Failed to load page: {error}
      </div>
    )
  }

  if (isLoading || !url) {
    return (
      <div className={cn("flex items-center justify-center p-8", className)}>
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <iframe
      key={reloadKey}
      src={url}
      title={path}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      className={cn("w-full h-full border-0 bg-white", className)}
    />
  )
}
