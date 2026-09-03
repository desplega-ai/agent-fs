import { useSyncExternalStore } from "react"
import type { QueryClient } from "@tanstack/react-query"
import { isConflictError, type AgentFsClient } from "@/api/client"
import { invalidateForPath } from "@/lib/listing-cache"
import { cleanPath, joinPath } from "@/lib/paths"
import { toast } from "./toast"

/** Server body limit for `PUT .../raw` (Hono `bodyLimit` and `MAX_RAW_FILE_SIZE`). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const MAX_CONCURRENT_UPLOADS = 3

export type UploadStatus =
  | "queued"
  | "uploading"
  | "done"
  /** Path already exists; waiting for the user to pick Replace or Skip. */
  | "conflict"
  | "error"
  /** Rejected client-side (over the size cap). Never sent. */
  | "rejected"
  | "skipped"

export interface UploadScope {
  client: AgentFsClient
  orgId: string
  driveId: string
  queryClient: QueryClient
}

export interface UploadItem {
  id: number
  /** Full drive-relative destination path. */
  path: string
  file: File
  /** Org, drive and client the item was dropped into; survives a drive switch. */
  scope: UploadScope
  status: UploadStatus
  /** 0..1 */
  progress: number
  error?: string
  version?: number
  /** Retry without `If-None-Match: *` after the user confirmed a replace. */
  overwrite: boolean
}

export interface UploadInput {
  file: File
  /** Path relative to the folder the files were dropped on. */
  relativePath: string
}

const FINISHED: ReadonlySet<UploadStatus> = new Set(["done", "error", "rejected", "skipped"])
export function isFinished(status: UploadStatus): boolean {
  return FINISHED.has(status)
}

/**
 * Destination path relative to the drop folder. react-dropzone (via
 * file-selector) sets `path` to the entry's full path for folder drops
 * (`/dir/sub/name.txt`) or `./name.txt` for loose files. A `webkitdirectory`
 * input sets the native `webkitRelativePath` (`dir/sub/name.txt`).
 */
export function toUploadInputs(files: File[]): UploadInput[] {
  return files.map((file) => {
    const withPath = file as File & { path?: string }
    const raw = withPath.path || file.webkitRelativePath || file.name
    const relativePath = cleanPath(raw.replace(/^\.\//, "")) || file.name
    return { file, relativePath }
  })
}

type Listener = () => void

let nextId = 1

/**
 * Upload queue. A module-level singleton (same pattern as `stores/toast.ts`)
 * so in-flight uploads survive navigation inside the app. At most
 * `MAX_CONCURRENT_UPLOADS` run at once; the first attempt is create-only and
 * a 409 parks the item in `conflict` until the user chooses Replace or Skip.
 */
class UploadStore {
  private items: UploadItem[] = []
  private listeners = new Set<Listener>()
  private controllers = new Map<number, AbortController>()
  private batch = { done: 0, failed: 0 }

  getItems(): UploadItem[] {
    return this.items
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit() {
    this.listeners.forEach((l) => l())
  }

  private update(id: number, patch: Partial<UploadItem>) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...patch } : i))
    this.emit()
  }

  enqueue(scope: UploadScope, folder: string, inputs: UploadInput[]) {
    const limitMb = MAX_UPLOAD_BYTES / 1024 / 1024
    const next: UploadItem[] = inputs.map(({ file, relativePath }) => {
      const tooBig = file.size > MAX_UPLOAD_BYTES
      return {
        id: nextId++,
        path: joinPath(folder, relativePath),
        file,
        scope,
        status: tooBig ? "rejected" : "queued",
        progress: 0,
        overwrite: false,
        error: tooBig ? `Larger than ${limitMb} MB` : undefined,
      }
    })
    this.items = [...this.items, ...next]
    this.emit()
    this.pump()
  }

  replace(id: number) {
    this.update(id, { status: "queued", overwrite: true, progress: 0, error: undefined })
    this.pump()
  }

  skip(id: number) {
    this.update(id, { status: "skipped" })
    this.summarizeIfDrained()
  }

  cancel(id: number) {
    const item = this.items.find((i) => i.id === id)
    if (!item) return
    if (item.status === "uploading") {
      this.controllers.get(id)?.abort()
    } else if (item.status === "queued") {
      this.update(id, { status: "skipped" })
      this.summarizeIfDrained()
    }
  }

  dismiss(id: number) {
    this.items = this.items.filter((i) => i.id !== id)
    this.emit()
  }

  clearFinished() {
    this.items = this.items.filter((i) => !isFinished(i.status))
    this.emit()
  }

  private pump() {
    let active = this.items.filter((i) => i.status === "uploading").length
    for (const item of this.items) {
      if (active >= MAX_CONCURRENT_UPLOADS) break
      if (item.status !== "queued") continue
      active++
      void this.run(item.id)
    }
  }

  private async run(id: number) {
    const item = this.items.find((i) => i.id === id)
    if (!item) return
    const { scope } = item
    const controller = new AbortController()
    this.controllers.set(id, controller)
    this.update(id, { status: "uploading", progress: 0 })
    try {
      const result = await scope.client.putRaw(scope.orgId, scope.driveId, item.path, item.file, {
        ifNoneMatch: !item.overwrite,
        message: "Uploaded from UI",
        signal: controller.signal,
        onProgress: (loaded, total) => {
          this.update(id, { progress: total > 0 ? loaded / total : 0 })
        },
      })
      this.update(id, { status: "done", progress: 1, version: result.version })
      invalidateForPath(scope.queryClient, scope.orgId, scope.driveId, item.path)
      this.batch.done++
    } catch (err) {
      const code = (err as { error?: string }).error
      if (isConflictError(err)) {
        this.update(id, { status: "conflict" })
      } else if (code === "ABORTED") {
        this.update(id, { status: "skipped" })
      } else {
        this.update(id, { status: "error", error: (err as Error).message || "Upload failed" })
        this.batch.failed++
      }
    } finally {
      this.controllers.delete(id)
      this.pump()
      this.summarizeIfDrained()
    }
  }

  /**
   * One toast per batch instead of one per file, once nothing is in flight
   * and no conflict is still waiting for a Replace or Skip decision.
   */
  private summarizeIfDrained() {
    const pending = this.items.some(
      (i) => i.status === "queued" || i.status === "uploading" || i.status === "conflict",
    )
    if (pending) return
    const { done, failed } = this.batch
    if (done === 0 && failed === 0) return
    this.batch = { done: 0, failed: 0 }
    if (failed > 0) {
      toast.error(`Uploaded ${done}, ${failed} failed`)
    } else {
      toast.success(done === 1 ? "Uploaded 1 file" : `Uploaded ${done} files`)
    }
  }
}

export const uploadStore = new UploadStore()

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(
    (cb) => uploadStore.subscribe(cb),
    () => uploadStore.getItems(),
    () => uploadStore.getItems(),
  )
}
