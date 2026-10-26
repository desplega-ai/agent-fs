import type { DriveMember } from "@/api/types"
import type { HealthResponse } from "./upload-limit"

export const COMMENT_MENTIONS_FEATURE = "comment-mentions"

/** Servers that accept `mentions` on comment-add say so in `/health`. Older servers get no picker. */
export function supportsCommentMentions(health?: HealthResponse): boolean {
  return health?.features?.includes(COMMENT_MENTIONS_FEATURE) === true
}

/** The `@query` being typed: `text.slice(start, end)` is `@` plus `query`. */
export interface MentionQuery {
  start: number
  end: number
  query: string
}

const MAX_QUERY_LENGTH = 64

/**
 * The mention the caret is in, if any. The `@` must open the text or follow
 * whitespace or an opening bracket, so an email address never opens the picker.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf("@")
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (query.length > MAX_QUERY_LENGTH || /[\s@]/.test(query)) return null
  if (at > 0 && !/[\s([{]/.test(before[at - 1])) return null
  return { start: at, end: caret, query }
}

/** The text a mention inserts after `@`: the display name, else the email. */
export function mentionLabel(member: DriveMember): string {
  return member.displayName?.trim() || member.email
}

/**
 * Members whose name, a word of the name, or email starts with `query`
 * (case-insensitive). Name-prefix matches rank first. The signed-in user is
 * left out: the server drops self-mentions anyway.
 */
export function filterMentionCandidates(
  members: readonly DriveMember[],
  query: string,
  selfId?: string,
  limit = 8,
): DriveMember[] {
  const needle = query.toLowerCase()
  const ranked: Array<{ member: DriveMember; rank: number }> = []
  for (const member of members) {
    if (member.userId === selfId) continue
    const name = member.displayName?.trim().toLowerCase() ?? ""
    const email = member.email.toLowerCase()
    let rank: number
    if (name.startsWith(needle)) rank = 0
    else if (name.split(/\s+/).some((word) => word.startsWith(needle))) rank = 1
    else if (email.startsWith(needle)) rank = 2
    else continue
    ranked.push({ member, rank })
  }
  ranked.sort((a, b) =>
    a.rank - b.rank || mentionLabel(a.member).localeCompare(mentionLabel(b.member)),
  )
  return ranked.slice(0, limit).map(({ member }) => member)
}

/** Replace the typed `@query` with `@Label ` and return the caret after it. */
export function insertMention(
  text: string,
  mention: MentionQuery,
  member: DriveMember,
): { text: string; caret: number } {
  const token = `@${mentionLabel(member)} `
  return {
    text: text.slice(0, mention.start) + token + text.slice(mention.end),
    caret: mention.start + token.length,
  }
}

/**
 * The `mentions` param for comment-add: user IDs of picked members whose
 * `@Label` is still in the body. Deleting the text drops the mention.
 */
export function collectMentions(body: string, picked: readonly DriveMember[]): string[] {
  const userIds = new Set<string>()
  for (const member of picked) {
    if (body.includes(`@${mentionLabel(member)}`)) userIds.add(member.userId)
  }
  return [...userIds]
}
