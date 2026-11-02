import { createStarNudge, defaultStarNudgeStorage, STAR_REPO_URL } from "@/lib/star-nudge"
import { toast } from "./toast"

const nudge = createStarNudge({
  storage: defaultStarNudgeStorage(),
  show: (onDone) => {
    toast("Enjoying agent-fs? A GitHub star helps others find it.", {
      duration: 0,
      onClose: onDone,
      action: {
        label: "Star on GitHub",
        onClick: () => {
          onDone()
          window.open(STAR_REPO_URL, "_blank", "noopener,noreferrer")
        },
      },
    })
  },
})

/** Call after a successful write action (comment, save, upload, create). */
export function recordWriteAction() {
  nudge.recordWriteAction()
}
