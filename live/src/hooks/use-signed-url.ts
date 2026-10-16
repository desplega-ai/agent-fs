import { useState, useEffect, useCallback } from "react"
import { useAuth } from "@/contexts/auth"
import type { AgentFsClient, SignedUrlDisposition } from "@/api/client"
import {
  MIN_FRESH_MS,
  driveImageCache,
  type DriveImageResolution,
  type DriveImageCacheEntry,
} from "@/lib/drive-image-cache"

/** Object URLs stay fresh for `MIN_FRESH_MS`, then the next open re-reads the image. */
const OBJECT_URL_TTL_MS = 2 * MIN_FRESH_MS

/**
 * @param disposition `inline` for URLs the browser must render (PDF iframe);
 *   omitted for download links, which keep the server's `attachment` default.
 */
export function useSignedUrl(path: string | null, disposition?: SignedUrlDisposition) {
  const { client, orgId, driveId } = useAuth()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!path || !orgId) {
      setUrl(null)
      return
    }

    let cancelled = false
    let objectUrl: string | null = null
    const controller = new AbortController()
    setIsLoading(true)
    setError(null)

    client.fetchableUrl(orgId, driveId, path, { disposition, signal: controller.signal }).then((result) => {
      if (result.objectUrl) objectUrl = result.url
      if (cancelled) {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        return
      }
      setUrl(result.url)
      setIsLoading(false)
    }).catch((err) => {
      if (!cancelled) {
        setError((err as Error).message)
        setIsLoading(false)
      }
    })

    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path, orgId, driveId, client, disposition])

  return { url, error, isLoading }
}

export type { DriveImageResolution }

async function mintDriveImageUrl(client: AgentFsClient, res: DriveImageResolution): Promise<DriveImageCacheEntry> {
  const result = await client.fetchableUrl(res.orgId, res.driveId, res.path)
  if (result.objectUrl) return { url: result.url, expiresAt: Date.now() + OBJECT_URL_TTL_MS, objectUrl: true }
  return {
    url: result.url,
    expiresAt: result.expiresAt ? new Date(result.expiresAt).getTime() : Infinity,
  }
}

/**
 * Like `useSignedUrl`, but mints against an explicit org/drive (not
 * necessarily the currently active one) and caches the result — needed for
 * markdown images, which can reference any drive the reader has access to
 * and can repeat the same image many times in one document.
 */
export function useDriveImageUrl(res: DriveImageResolution | null) {
  const { client, credential } = useAuth()
  const clientId = credential.id
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!res) {
      setUrl(null)
      setError(null)
      return
    }

    const cached = driveImageCache.getFresh(clientId, res)
    let cancelled = false
    let held: string | null = null
    const show = (shown: string) => {
      driveImageCache.hold(shown)
      held = shown
      setUrl(shown)
      setError(null)
      setIsLoading(false)
    }
    const cleanup = () => {
      cancelled = true
      if (held) driveImageCache.release(held)
    }

    if (cached) {
      show(cached.url)
      return cleanup
    }

    setIsLoading(true)
    setError(null)

    const existing = driveImageCache.get(clientId, res)
    const pending = existing instanceof Promise ? existing : mintDriveImageUrl(client, res)
    driveImageCache.set(clientId, res, pending)
    pending.then((entry) => {
      driveImageCache.set(clientId, res, entry)
      if (!cancelled) show(entry.url)
    }).catch((err: unknown) => {
      driveImageCache.delete(clientId, res)
      if (cancelled) return
      setError((err as Error).message)
      setIsLoading(false)
    })

    return cleanup
  }, [res?.orgId, res?.driveId, res?.path, client, clientId, nonce])

  // Drops the cached entry and re-mints — used for the single-retry-on-load-error path.
  const retry = useCallback(() => {
    if (res) driveImageCache.delete(clientId, res)
    setNonce((n) => n + 1)
  }, [res?.orgId, res?.driveId, res?.path, clientId])

  return { url, error, isLoading, retry }
}
