import { createContext, useContext, useRef } from "react"
import { ImageOff } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useDriveImageUrl } from "@/hooks/use-signed-url"
import { resolveImageSrc } from "@/lib/resolve-image-src"
import { useDriveResolution } from "@/hooks/use-drive-resolution"
import { ExpandableImage } from "./ExpandableImage"
import { Spinner } from "@/components/ui/spinner"

// Carries the open document's drive path down to `MarkdownImage`, so a
// relative `src` (`./x.png`) can resolve against the document's directory.
// `MarkdownViewer` renders the provider; kept out of its module-static
// `markdownComponents` map, which components read this via context instead of
// a prop.
export const MarkdownDocContext = createContext<string>("")

export function useMarkdownDocPath(): string {
  return useContext(MarkdownDocContext)
}

interface MarkdownImageProps {
  src: string
  alt?: string
  title?: string
}

function ImagePlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <span className="my-2 flex h-32 max-w-full flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted/30 px-4 text-sm text-muted-foreground">
      {children}
    </span>
  )
}

export function MarkdownImage({ src, alt, title }: MarkdownImageProps) {
  const docPath = useMarkdownDocPath()
  const { orgId, driveId } = useAuth()
  const resolution = resolveImageSrc(src, docPath, orgId ?? "", driveId)
  const hasRetried = useRef(false)

  if (resolution.kind === "external") {
    return <ExpandableImage src={resolution.url} alt={alt} title={title} />
  }

  if (resolution.kind === "drive-name") {
    return (
      <NamedDriveImage
        orgName={resolution.orgName}
        driveName={resolution.driveName}
        path={resolution.path}
        alt={alt}
        title={title}
        hasRetriedRef={hasRetried}
      />
    )
  }

  return (
    <DriveImage
      orgId={resolution.orgId}
      driveId={resolution.driveId}
      path={resolution.path}
      alt={alt}
      title={title}
      hasRetriedRef={hasRetried}
    />
  )
}

/**
 * An image linked by org and drive name. It loads only once the names point at
 * exactly one drive the viewer can open; never the first match or the drive of
 * the document.
 */
function NamedDriveImage({
  orgName,
  driveName,
  path,
  alt,
  title,
  hasRetriedRef,
}: {
  orgName: string
  driveName: string
  path: string
  alt?: string
  title?: string
  hasRetriedRef: React.MutableRefObject<boolean>
}) {
  const resolution = useDriveResolution({ names: { org: orgName, drive: driveName } })
  if (resolution.status === "ready") {
    const { orgId, driveId } = resolution.ids
    return <DriveImage orgId={orgId} driveId={driveId} path={path} alt={alt} title={title} hasRetriedRef={hasRetriedRef} />
  }
  if (resolution.status === "loading") return <ImagePlaceholder><Spinner size="sm" /></ImagePlaceholder>
  const reason = resolution.status === "ambiguous" ? "more than one drive has that name" : resolution.status === "failed" ? "couldn’t load your drives" : "no such drive"
  return (
    <ImagePlaceholder>
      <span className="flex items-center gap-2">
        <ImageOff className="size-4 shrink-0" />
        {alt && <span>{alt}</span>}
      </span>
      <span className="text-xs">Image not available: {reason}</span>
    </ImagePlaceholder>
  )
}

function DriveImage({
  orgId,
  driveId,
  path,
  alt,
  title,
  hasRetriedRef,
}: {
  orgId: string
  driveId: string
  path: string
  alt?: string
  title?: string
  hasRetriedRef: React.MutableRefObject<boolean>
}) {
  const { url, error, isLoading, retry } = useDriveImageUrl({ orgId, driveId, path })

  if (error) {
    return (
      <ImagePlaceholder>
        <span className="flex items-center gap-2">
          <ImageOff className="size-4 shrink-0" />
          {alt && <span>{alt}</span>}
        </span>
        <span className="text-xs">Image not available: {error}</span>
      </ImagePlaceholder>
    )
  }

  if (isLoading || !url) {
    return (
      <ImagePlaceholder>
        <Spinner size="sm" />
        {alt && <span>{alt}</span>}
      </ImagePlaceholder>
    )
  }

  return (
    <ExpandableImage
      src={url}
      filename={path.split("/").filter(Boolean).pop()}
      alt={alt}
      title={title}
      onError={() => {
        if (hasRetriedRef.current) return
        hasRetriedRef.current = true
        retry()
      }}
    />
  )
}
