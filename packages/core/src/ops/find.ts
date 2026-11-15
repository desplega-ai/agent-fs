import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, FindParams, FindResult, FindMatch } from "./types.js";
import { normalizePrefix } from "./paths.js";

const DEFAULT_LIMIT = 50;

// Per-word scores. A contiguous hit always beats a subsequence hit (which
// stays below SUBSTRING), and a hit in the file name counts double a hit in a
// folder name.
const SUBSTRING = 10;
const WORD_START = 5;
const WHOLE_WORD = 3;
const NAME_WEIGHT = 2;

// Nonspacing marks only (accents, umlauts). Spacing vowel signs in Indic or
// Arabic scripts carry meaning and stay.
const MARKS = /\p{Mn}/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const NON_WORD = /[^\p{L}\p{N}]+/u;

/** Lowercase and strip accents, so "Café" and "cafe" compare equal. */
function foldText(text: string): string {
  // Lowercasing picks σ or ς for Σ by position. Use one form.
  return text.normalize("NFD").replace(MARKS, "").toLowerCase().replace(/ς/g, "σ");
}

/** Split a query into words on whitespace and punctuation (`/ _ - .` and the rest). */
export function queryWords(query: string): string[] {
  // A repeated word adds no filtering, only another pass over every file.
  return [...new Set(foldText(query).split(NON_WORD).filter(Boolean))];
}

interface Segment {
  text: string;
  /** True where a word starts: after punctuation or at a camelCase hump. */
  starts: boolean[];
}

function segmentOf(raw: string): Segment {
  // `plain` keeps its case, so camelCase humps stay visible. After NFD,
  // lowercasing keeps every index in place, so `plain` and `text` line up.
  const plain = raw.normalize("NFD").replace(MARKS, "");
  const text = foldText(plain);
  const starts = new Array<boolean>(text.length);
  for (let i = 0; i < text.length; i++) {
    starts[i] =
      i === 0 ||
      !WORD_CHAR.test(text[i - 1]) ||
      (plain[i] !== plain[i].toLowerCase() && plain[i - 1] !== plain[i - 1].toUpperCase());
  }
  return { text, starts };
}

function isSubsequence(word: string, text: string): boolean {
  let pos = -1;
  for (const char of word) {
    pos = text.indexOf(char, pos + 1);
    if (pos === -1) return false;
  }
  return true;
}

/**
 * fzf-style fallback: the word's letters appear in order inside one segment,
 * starting at a word start ("zphr" finds "Zephyr"). Bonuses for letters
 * that sit at word starts or right after the previous letter.
 */
function subsequenceScore(word: string, seg: Segment): number {
  const n = word.length;
  // chain[k]: where word[k] sits in the last full match. tail[k]: word starts
  // plus adjacent pairs over chain[k..].
  const chain: number[] = [];
  const tail = new Array<number>(n + 1).fill(0);
  let best = 0;
  for (let start = seg.text.indexOf(word[0]); start !== -1; start = seg.text.indexOf(word[0], start + 1)) {
    if (!seg.starts[start]) continue;
    // A later start never matches a letter before the last match does. Once it
    // reaches a spot before chain[k], it continues along chain[k..], so only
    // the new head is scanned and the total work stays linear.
    const head = [start];
    let k = 1;
    for (let pos = start; k < n && !(chain.length > 0 && pos < chain[k]); k++) {
      pos = seg.text.indexOf(word[k], pos + 1);
      // A later start leaves fewer letters to match, so it cannot succeed either.
      if (pos === -1) return best;
      head.push(pos);
    }
    chain.splice(0, k, ...head);
    for (let j = Math.min(k, n - 1); j >= 0; j--) {
      tail[j] = (seg.starts[chain[j]] ? 1 : 0) + (j > 0 && chain[j] === chain[j - 1] + 1 ? 1 : 0) + tail[j + 1];
    }
    best = Math.max(best, 1 + (4 * tail[0]) / n);
  }
  return best;
}

/**
 * Score one query word against one path segment. A contiguous hit scores
 * SUBSTRING or more, a subsequence hit less. 0 means no match.
 */
function wordScore(word: string, seg: Segment): number {
  let best = 0;
  for (let at = seg.text.indexOf(word); at !== -1; at = seg.text.indexOf(word, at + 1)) {
    let score = SUBSTRING;
    if (seg.starts[at]) {
      score += WORD_START;
      const end = at + word.length;
      if (end === seg.text.length || seg.starts[end] || !WORD_CHAR.test(seg.text[end])) {
        score += WHOLE_WORD;
      }
    }
    best = Math.max(best, score);
  }
  return best || subsequenceScore(word, seg);
}

/**
 * Score a drive-relative path against the query words. Every word must match
 * some segment, and each word takes its best segment. Null when a word
 * matches nowhere. `fuzzy` is true when some word matched only with skipped
 * letters.
 */
export function pathScore(
  words: string[],
  relativePath: string,
): { score: number; fuzzy: boolean } | null {
  const segments = relativePath.split("/").filter(Boolean).map(segmentOf);
  let score = 0;
  let fuzzy = false;
  for (const word of words) {
    let best = 0;
    let contiguous = false;
    segments.forEach((seg, i) => {
      const raw = wordScore(word, seg);
      if (raw >= SUBSTRING) contiguous = true;
      best = Math.max(best, raw * (i === segments.length - 1 ? NAME_WEIGHT : 1));
    });
    if (best === 0) return null;
    score += best;
    fuzzy ||= !contiguous;
  }
  return { score, fuzzy };
}

function compareMatches(a: FindMatch, b: FindMatch): number {
  return (
    b.score - a.score ||
    a.path.length - b.path.length ||
    (b.modifiedAt?.getTime() ?? 0) - (a.modifiedAt?.getTime() ?? 0) ||
    a.path.localeCompare(b.path)
  );
}

export async function find(
  ctx: OpContext,
  params: FindParams
): Promise<FindResult> {
  const words = queryWords(params.query);
  if (words.length === 0) return { matches: [], total: 0 };
  const prefix = params.path ? normalizePrefix(params.path) : "/";

  const rows = ctx.db
    .select({
      path: schema.files.path,
      size: schema.files.size,
      modifiedAt: schema.files.modifiedAt,
    })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.driveId, ctx.driveId),
        eq(schema.files.isDeleted, false)
      )
    )
    .all();

  const exact: FindMatch[] = [];
  const fuzzy: FindMatch[] = [];
  for (const row of rows) {
    if (!row.path.startsWith(prefix)) continue;
    // Match below the scope prefix only: inside /decks/, "deck" must not hit every file.
    const relativePath = row.path.slice(prefix.length);
    const folded = foldText(relativePath);
    if (!words.every((word) => isSubsequence(word, folded))) continue;
    const result = pathScore(words, relativePath);
    if (!result) continue;
    (result.fuzzy ? fuzzy : exact).push({ ...row, score: Math.round(result.score * 100) / 100 });
  }

  // Skipped letters are a fallback. "report" would otherwise also match
  // "retry-poller.ts", so those hits show only when no file has every word as typed.
  const matches = exact.length > 0 ? exact : fuzzy;
  matches.sort(compareMatches);
  return { matches: matches.slice(0, params.limit ?? DEFAULT_LIMIT), total: matches.length };
}
