import { useId, useLayoutEffect, useRef, useState } from "react"
import type { DriveMember } from "@/api/types"
import { UserAvatar } from "@/components/UserAvatar"
import {
  collectMentions,
  filterMentionCandidates,
  findMentionQuery,
  insertMention,
  mentionLabel,
} from "@/lib/comment-mentions"
import { cn } from "@/lib/utils"

interface UseMentionPickerOptions {
  value: string
  onValueChange: (value: string) => void
  /** Drive members to suggest. An empty list turns the picker off. */
  members: readonly DriveMember[]
  selfId?: string
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

/**
 * `@` suggestions for a comment textarea. Spread `textareaProps` on the
 * textarea, call `syncCaret` from its onChange, give `handleKeyDown` the first
 * look at key presses, and render `list` where the suggestions should appear.
 * `mentions` is the comment-add `mentions` param (drive-member user IDs).
 */
export function useMentionPicker({
  value,
  onValueChange,
  members,
  selfId,
  textareaRef,
}: UseMentionPickerOptions) {
  const listId = useId()
  const [caret, setCaret] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // Esc hides the list until the caret leaves this `@`.
  const [dismissedStart, setDismissedStart] = useState<number | null>(null)
  const [picked, setPicked] = useState<DriveMember[]>([])
  const pendingCaret = useRef<number | null>(null)

  const query = caret === null ? null : findMentionQuery(value, caret)
  const candidates =
    query && members.length > 0 && query.start !== dismissedStart
      ? filterMentionCandidates(members, query.query, selfId)
      : []
  const open = candidates.length > 0
  const active = Math.min(activeIndex, candidates.length - 1)

  // Put the caret after an inserted mention once React has written the value.
  useLayoutEffect(() => {
    const next = pendingCaret.current
    if (next === null) return
    pendingCaret.current = null
    textareaRef.current?.setSelectionRange(next, next)
  }, [value, textareaRef])

  const syncCaret = (el: HTMLTextAreaElement) => {
    const position = el.selectionStart === el.selectionEnd ? el.selectionStart : null
    setCaret(position)
    setActiveIndex(0)
    const next = position === null ? null : findMentionQuery(el.value, position)
    if (next?.start !== dismissedStart) setDismissedStart(null)
  }

  const select = (member: DriveMember) => {
    if (!query) return
    const next = insertMention(value, query, member)
    pendingCaret.current = next.caret
    setCaret(next.caret)
    setActiveIndex(0)
    setPicked((current) =>
      current.some((entry) => entry.userId === member.userId) ? current : [...current, member],
    )
    onValueChange(next.text)
    textareaRef.current?.focus()
  }

  /** Returns true when the key drove the picker and the caller must ignore it. */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !query || e.nativeEvent.isComposing) return false
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1
      setActiveIndex((active + step + candidates.length) % candidates.length)
    } else if ((e.key === "Enter" && plain && !e.shiftKey) || (e.key === "Tab" && plain && !e.shiftKey)) {
      select(candidates[active])
    } else if (e.key === "Escape") {
      setDismissedStart(query.start)
      // Keep Esc from also closing the comment form or side panel.
      e.stopPropagation()
    } else {
      return false
    }
    e.preventDefault()
    return true
  }

  const optionId = (index: number) => `${listId}-option-${index}`

  return {
    mentions: collectMentions(value, picked),
    syncCaret,
    handleKeyDown,
    reset: () => {
      setPicked([])
      setDismissedStart(null)
    },
    textareaProps: {
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open ? optionId(active) : undefined,
      onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => syncCaret(e.currentTarget),
      onBlur: () => setCaret(null),
    },
    list: open ? (
      <ul
        id={listId}
        role="listbox"
        aria-label="Mention a drive member"
        className="max-h-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
      >
        {candidates.map((member, index) => {
          const label = mentionLabel(member)
          // Agent identities can use a UUID as the email local part (or the whole value).
          const uuidEmail = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:@|$)/i.test(member.email)
          return (
            <li
              key={member.userId}
              id={optionId(index)}
              role="option"
              title={member.email}
              aria-selected={index === active}
              // Keep focus (and the caret) in the textarea.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(member)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                index === active && "bg-accent text-accent-foreground",
              )}
            >
              <UserAvatar userId={member.userId} displayName={member.displayName ?? undefined} />
              <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                <span className="max-w-full shrink-0 truncate">{label}</span>
                {label !== member.email && !uuidEmail && (
                  <span className="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground">{member.email}</span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    ) : null,
  }
}
