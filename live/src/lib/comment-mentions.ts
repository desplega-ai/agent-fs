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
/** A label followed by one of these code points was edited into a different name. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}_@]/u
/**
 * What may sit right before a mention's `@`: whitespace, an opening bracket,
 * a straight or curly quote, or a colon. Anything else, `+ - . %` included,
 * can end a word or an email local part, so an `@` after it is not a mention.
 */
const MENTION_OPENER = /[\s([{"'\u2018\u2019\u201C\u201D:]/

/** Whether an `@` at `index` opens a mention: at the start of text or after an opener. */
function opensMention(text: string, index: number): boolean {
  return index === 0 || MENTION_OPENER.test(text[index - 1])
}

/** Whether the code point starting at `index` continues a word. */
function wordCharAt(text: string, index: number): boolean {
  const next = text.codePointAt(index)
  return next !== undefined && WORD_CHAR.test(String.fromCodePoint(next))
}

/**
 * The mention the caret is in, if any. The `@` must open the text or follow
 * an opener (whitespace, a bracket, a quote, a colon), so an email address
 * never opens the picker.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf("@")
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (query.length > MAX_QUERY_LENGTH || /[\s@]/.test(query)) return null
  if (!opensMention(before, at)) return null
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
 * `@Label` token is still intact in the body. A token opens like a typed
 * mention and must not run on into a letter, number or combining mark, so
 * `@Ada LovelaceX` mentions nobody. At each `@` only the longest picked label
 * counts, so `@Ada Lovelace` never also mentions a picked `Ada`.
 */
export function collectMentions(body: string, picked: readonly DriveMember[]): string[] {
  const idsByLabel = new Map<string, string[]>()
  for (const member of picked) {
    const label = mentionLabel(member)
    idsByLabel.set(label, [...(idsByLabel.get(label) ?? []), member.userId])
  }
  const labels = [...idsByLabel.keys()].sort((a, b) => b.length - a.length)
  const userIds = new Set<string>()
  for (let at = body.indexOf("@"); at >= 0; at = body.indexOf("@", at + 1)) {
    if (!opensMention(body, at)) continue
    const label = labels.find((l) => body.startsWith(l, at + 1))
    if (label === undefined) continue
    const end = at + 1 + label.length
    if (wordCharAt(body, end)) continue
    for (const id of idsByLabel.get(label)!) userIds.add(id)
    // Skip the token so an `@` inside an email label is not read as a new mention.
    at = end - 1
  }
  return [...userIds]
}
