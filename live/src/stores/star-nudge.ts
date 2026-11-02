import { createStarNudge, defaultStarNudgeStorage, STAR_REPO_URL } from "@/lib/star-nudge"
import { toast, type ToastOptions } from "./toast"

export const STAR_NUDGE_MESSAGE = "Enjoying agent-fs?"
export const STAR_NUDGE_DESCRIPTION = "A GitHub star helps others find it."

/** Sticky so later notifications cannot push it off the capped toast stack. */
export function showStarNudgeToast(
  onDone: () => void,
  notify: (message: string, opts?: ToastOptions) => number = toast,
) {
  notify(STAR_NUDGE_MESSAGE, {
    description: STAR_NUDGE_DESCRIPTION,
    variant: "invite",
    duration: 0,
    sticky: true,
    onClose: onDone,
    action: {
      label: "Star on GitHub",
      onClick: () => {
        onDone()
        window.open(STAR_REPO_URL, "_blank", "noopener,noreferrer")
      },
    },
  })
}

const nudge = createStarNudge({
  storage: defaultStarNudgeStorage(),
  show: showStarNudgeToast,
})

/** Call after a successful write action (comment, save, upload, create). */
export function recordWriteAction() {
  nudge.recordWriteAction()
}
