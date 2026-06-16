import { useState, useCallback } from "react"
import { useAuth } from "@/contexts/auth"
import type { WriteResult } from "@/api/types"

interface UseFileSaveOptions {
  path: string
  expectedVersion?: number
}

export function useFileSave({ path, expectedVersion }: UseFileSaveOptions) {
  const { client, orgId, driveId } = useAuth()
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [savedVersion, setSavedVersion] = useState<number | null>(null)

  const save = useCallback(
    async (content: string): Promise<WriteResult> => {
      if (!orgId || !driveId) throw new Error("No active org or drive")
      setIsSaving(true)
      setError(null)
      try {
        const result = await client.write(orgId, driveId, {
          path,
          content,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        })
        setSavedVersion(result.version)
        return result
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        setError(e)
        throw e
      } finally {
        setIsSaving(false)
      }
    },
    [client, orgId, driveId, path, expectedVersion],
  )

  return { save, isSaving, error, savedVersion }
}
