/**
 * GitHub star nudge. Counts the user's successful write actions (comment or
 * reply posted, editor save, upload batch, file or folder created) in
 * localStorage and asks for a star once the count reaches the threshold.
 * Closing the notice or clicking its button retires it for good. A reload
 * while the notice is still open (never closed) shows it again on the next
 * write action.
 */
export const STAR_NUDGE_THRESHOLD = 5
export const STAR_NUDGE_COUNT_KEY = "agent-fs:star-nudge:count"
export const STAR_NUDGE_DONE_KEY = "agent-fs:star-nudge:done"
export const STAR_REPO_URL = "https://github.com/desplega-ai/agent-fs"

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">

export interface StarNudgeDeps {
  storage: KeyValueStorage | null
  /** Shows the notice. Call `onDone` when the user closes it or clicks its button. */
  show: (onDone: () => void) => void
}

export interface StarNudge {
  /** Record one successful write action; returns true when this call showed the notice. */
  recordWriteAction(): boolean
}

export function defaultStarNudgeStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

export function createStarNudge({ storage, show }: StarNudgeDeps): StarNudge {
  let shownThisPage = false

  const markDone = () => {
    try {
      storage?.setItem(STAR_NUDGE_DONE_KEY, "1")
    } catch {
      // Storage full or blocked: the notice may come back after a reload.
    }
  }

  return {
    recordWriteAction() {
      if (!storage || shownThisPage) return false
      try {
        if (storage.getItem(STAR_NUDGE_DONE_KEY)) return false
        const prev = Number.parseInt(storage.getItem(STAR_NUDGE_COUNT_KEY) ?? "", 10)
        const count = (Number.isFinite(prev) && prev > 0 ? prev : 0) + 1
        storage.setItem(STAR_NUDGE_COUNT_KEY, String(count))
        if (count < STAR_NUDGE_THRESHOLD) return false
      } catch {
        return false
      }
      shownThisPage = true
      show(markDone)
      return true
    },
  }
}
