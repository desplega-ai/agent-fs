import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { isConflictError, type ApiError } from "@/api/client"
import { invalidateForPath } from "@/lib/listing-cache"
import { basenameOf, joinPath } from "@/lib/paths"

/** Placeholder written so an empty folder persists and shows up in `ls`. */
export const KEEP_FILE = ".keep"

function alreadyExists(path: string): Error {
  return Object.assign(new Error(`Something already exists at ${path}.`), {
    error: "EDIT_CONFLICT",
    status: 409,
  })
}

/**
 * Structural file mutations for the UI: create, create folder, rename, delete.
 * Each call goes through the existing JSON ops (`write`, `mv`, `rm`) and then
 * invalidates the listings and stat entries the change affects.
 */
export function useFileMutations() {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()

  /**
   * True when an object exists at `path`. `stat` heads the stored object, so
   * it sees files regardless of which route wrote their version rows. Only a
   * NOT_FOUND answer counts as "free"; any other failure is rethrown so a
   * network blip cannot be mistaken for a vacant path.
   */
  const exists = useCallback(
    async (path: string): Promise<boolean> => {
      if (!orgId || !driveId) throw new Error("No org/drive selected")
      try {
        await client.callOp(orgId, "stat", { path }, driveId)
        return true
      } catch (err) {
        const e = err as Partial<ApiError>
        if (e.error === "NOT_FOUND" || e.status === 404) return false
        throw err
      }
    },
    [client, orgId, driveId],
  )

  /**
   * Create-only write. `expectedVersion: 0` is the server's create guard, but
   * two cases need help from `stat`:
   * - a file uploaded through `PUT /raw` keeps its version rows under the
   *   `/path` form, so the JSON op would see version 0 and overwrite it;
   * - a deleted path keeps its delete-marker rows, so the JSON op rejects a
   *   legitimate re-creation with a conflict.
   * So: refuse when the object exists, then write create-only, and on a
   * conflict re-check the object and write unconditionally only if it is
   * still absent.
   */
  const writeCreateOnly = useCallback(
    async (path: string, content: string, message: string): Promise<void> => {
      if (!orgId || !driveId) throw new Error("No org/drive selected")
      if (await exists(path)) throw alreadyExists(path)
      try {
        await client.write(orgId, driveId, { path, content, expectedVersion: 0, message })
      } catch (err) {
        if (!isConflictError(err)) throw err
        if (await exists(path)) throw alreadyExists(path)
        await client.write(orgId, driveId, { path, content, message })
      }
      invalidateForPath(queryClient, orgId, driveId, path)
    },
    [client, orgId, driveId, queryClient, exists],
  )

  /**
   * Markdown gets a one-line heading so the file is not zero bytes;
   * everything else starts empty. Returns the full drive-relative path.
   */
  const createFile = useCallback(
    async (base: string, relative: string): Promise<string> => {
      const path = joinPath(base, relative)
      const name = basenameOf(path)
      const mdMatch = /\.(md|mdx)$/i.exec(name)
      const content = mdMatch ? `# ${name.slice(0, -mdMatch[0].length)}\n` : ""
      await writeCreateOnly(path, content, "Created in UI")
      return path
    },
    [writeCreateOnly],
  )

  /** Writes `<folder>/.keep` create-only. Returns the folder path. */
  const createFolder = useCallback(
    async (base: string, relative: string): Promise<string> => {
      const folder = joinPath(base, relative)
      await writeCreateOnly(joinPath(folder, KEEP_FILE), "", "Created folder in UI")
      return folder
    },
    [writeCreateOnly],
  )

  const renameFile = useCallback(
    async (from: string, to: string): Promise<void> => {
      if (!orgId || !driveId) throw new Error("No org/drive selected")
      await client.mv(orgId, driveId, { from, to })
      invalidateForPath(queryClient, orgId, driveId, from)
      invalidateForPath(queryClient, orgId, driveId, to)
    },
    [client, orgId, driveId, queryClient],
  )

  const deleteFile = useCallback(
    async (path: string): Promise<void> => {
      if (!orgId || !driveId) throw new Error("No org/drive selected")
      await client.rm(orgId, driveId, { path })
      invalidateForPath(queryClient, orgId, driveId, path)
    },
    [client, orgId, driveId, queryClient],
  )

  return { createFile, createFolder, exists, renameFile, deleteFile }
}
