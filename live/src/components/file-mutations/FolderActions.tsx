import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { FilePlus, FolderPlus, FolderUp, Plus, Upload } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MAX_UPLOAD_BYTES, toUploadInputs, uploadStore } from "@/stores/upload"
import { NewEntryDialog, type NewEntryKind } from "./NewEntryDialog"

interface FolderActionsProps {
  /** Folder the actions target ("" for the drive root). */
  folder: string
  size?: "icon-xs" | "icon-sm"
  className?: string
}

const UPLOAD_LIMIT_LABEL = `${MAX_UPLOAD_BYTES / 1024 / 1024} MB`

/**
 * Two icon dropdowns, "New" (file or folder) and "Upload" (files or folder),
 * bound to one target folder. Used in the folder view header and the sidebar
 * so creating and uploading stays one click away while a file is open.
 */
export function FolderActions({ folder, size = "icon-sm", className }: FolderActionsProps) {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<NewEntryKind | null>(null)
  const filesInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)
  const enabled = !!orgId && !!driveId
  const where = folder || "drive root"

  // `webkitdirectory` is not a typed React attribute; set it imperatively.
  useEffect(() => {
    dirInputRef.current?.setAttribute("webkitdirectory", "")
  }, [])

  const enqueue = (files: FileList | null) => {
    if (!orgId || !driveId || !files || files.length === 0) return
    uploadStore.enqueue({ client, orgId, driveId, queryClient }, folder, toUploadInputs(Array.from(files)))
  }

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <input
        ref={filesInputRef}
        type="file"
        multiple
        className="hidden"
        aria-label="Upload files"
        onChange={(e) => {
          enqueue(e.target.files)
          e.target.value = ""
        }}
      />
      <input
        ref={dirInputRef}
        type="file"
        multiple
        className="hidden"
        aria-label="Upload folder"
        onChange={(e) => {
          enqueue(e.target.files)
          e.target.value = ""
        }}
      />

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size={size}
                    className="text-muted-foreground"
                    aria-label={`New in ${where}`}
                    disabled={!enabled}
                  />
                }
              />
            }
          >
            <Plus />
          </TooltipTrigger>
          <TooltipContent>New file or folder in {where}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem onClick={() => setDialog("file")}>
            <FilePlus />
            New file…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog("folder")}>
            <FolderPlus />
            New folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size={size}
                    className="text-muted-foreground"
                    aria-label={`Upload to ${where}`}
                    disabled={!enabled}
                  />
                }
              />
            }
          >
            <Upload />
          </TooltipTrigger>
          <TooltipContent>Upload to {where} (up to {UPLOAD_LIMIT_LABEL} per file)</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem onClick={() => filesInputRef.current?.click()}>
            <Upload />
            Files…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => dirInputRef.current?.click()}>
            <FolderUp />
            Folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog && (
        <NewEntryDialog
          kind={dialog}
          basePath={folder}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        />
      )}
    </div>
  )
}
