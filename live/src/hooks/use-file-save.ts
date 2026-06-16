import { useState, useCallback, useRef } from "react"
import { useAuth } from "@/contexts/auth"
import type { WriteResult } from "@/api/types"

interface UseFileSaveReturn {
  save: (content: string, expectedVersion?: number) => Promise<WriteResult>
  isSaving: boolean
  error: Error | null
  savedVersion: number | null
  clearError: () => void
}

export function useFileSave(path: string): UseFileSaveReturn {
  const { client, orgId, driveId } = useAuth()
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [savedVersion, setSavedVersion] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const save = useCallback(async (content: string, expectedVersion?: number): Promise<WriteResult> => {
    if (!orgId || !driveId) throw new Error("No org/drive selected")

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsSaving(true)
    setError(null)

    try {
      const result = await client.write(orgId, driveId, {
        path,
        content,
        expectedVersion,
      })

      if (controller.signal.aborted) throw new Error("Save aborted")

      setSavedVersion(result.version)
      return result
    } catch (err) {
      if (!controller.signal.aborted) {
        const e = err instanceof Error ? err : new Error(String(err))
        setError(e)
        throw e
      }
      throw err
    } finally {
      if (!controller.signal.aborted) {
        setIsSaving(false)
      }
    }
  }, [client, orgId, driveId, path])

  const clearError = useCallback(() => setError(null), [])

  return { save, isSaving, error, savedVersion, clearError }
}
