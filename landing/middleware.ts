// Vercel Routing Middleware (Edge runtime) for the agent-fs.dev landing.
//
// Implements content negotiation per https://acceptmarkdown.com/ spec:
//   1. Serve `Content-Type: text/markdown; charset=utf-8` when Accept prefers
//      markdown for negotiated routes.
//   2. Emit `Vary: Accept` on every negotiated response.
//   3. Return 406 Not Acceptable when no supported representation has q > 0.
//   4. Parse `Accept` per RFC 9110 — q-values, specificity, q=0 rejection.
//
// The landing is a Vite SPA with two negotiated routes:
//   `/`          — text/html (default) or text/markdown
//   `/llms.txt`  — text/markdown only
// All other paths fall through to the SPA rewrite in `vercel.json`.
//
// Middleware.ts at the project root works for non-Next.js projects on Vercel
// — see https://vercel.com/docs/routing-middleware/getting-started
// and https://vercel.com/docs/routing-middleware/api (the `next()` helper
// from `@vercel/functions` is the canonical passthrough for generic projects).

import { next } from "@vercel/functions";

import { INDEX_MD, LLMS_TXT } from "./content/markdown";

export const config = {
  runtime: "edge",
  matcher: ["/", "/llms.txt"],
};

type AcceptEntry = {
  type: string;
  subtype: string;
  q: number;
  specificity: number;
};

const MARKDOWN = "text/markdown";
const HTML = "text/html";

/**
 * Parse an `Accept` header per RFC 9110 §12.5.1.
 * Returns entries in source order. Callers resolve q by picking the most
 * specific matching entry for each candidate offer.
 */
function parseAccept(header: string): AcceptEntry[] {
  const entries: AcceptEntry[] = [];
  if (!header.trim()) return entries;

  for (const raw of header.split(",")) {
    const parts = raw
      .trim()
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;

    const mediaType = parts[0].toLowerCase();
    const slash = mediaType.indexOf("/");
    if (slash < 1 || slash === mediaType.length - 1) continue;
    const type = mediaType.slice(0, slash);
    const subtype = mediaType.slice(slash + 1);

    let q = 1;
    let extraParams = 0;
    for (let i = 1; i < parts.length; i++) {
      const eq = parts[i].indexOf("=");
      if (eq < 0) continue;
      const key = parts[i].slice(0, eq).trim().toLowerCase();
      const value = parts[i]
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "");
      if (key === "q") {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) q = Math.max(0, Math.min(1, parsed));
      } else {
        extraParams++;
      }
    }

    let specificity: number;
    if (type === "*" && subtype === "*") specificity = 0;
    else if (subtype === "*") specificity = 1;
    else specificity = 2 + extraParams;

    entries.push({ type, subtype, q, specificity });
  }
  return entries;
}

function matchEntry(offer: string, entry: AcceptEntry): boolean {
  const slash = offer.indexOf("/");
  const t = offer.slice(0, slash);
  const s = offer.slice(slash + 1);
  if (entry.type === "*" && entry.subtype === "*") return true;
  if (entry.type === t && entry.subtype === "*") return true;
  return entry.type === t && entry.subtype === s;
}

/**
 * Per RFC 9110, the most-specific matching media-range determines the
 * effective q-value for an offer. A `text/markdown;q=0` entry therefore
 * overrides a later `* / *` wildcard — the whole point of q=0.
 */
function effectiveQ(offer: string, entries: AcceptEntry[]): number {
  let bestSpec = -1;
  let q = 0;
  let matched = false;
  for (const entry of entries) {
    if (!matchEntry(offer, entry)) continue;
    matched = true;
    if (entry.specificity > bestSpec) {
      bestSpec = entry.specificity;
      q = entry.q;
    }
  }
  return matched ? q : 0;
}

/**
 * Picks the best offer given an Accept header. Server preference (argument
 * order) is the tie-breaker on equal q-values.
 *
 * Returns null when no offer has effective q > 0 — the 406 case.
 */
function negotiate(accept: string, offers: readonly string[]): string | null {
  const entries = accept.trim() ? parseAccept(accept) : parseAccept("*/*");
  let bestOffer: string | null = null;
  let bestQ = -1;
  let bestIdx = Number.POSITIVE_INFINITY;
  for (let idx = 0; idx < offers.length; idx++) {
    const offer = offers[idx];
    const q = effectiveQ(offer, entries);
    if (q <= 0) continue;
    if (q > bestQ || (q === bestQ && idx < bestIdx)) {
      bestOffer = offer;
      bestQ = q;
      bestIdx = idx;
    }
  }
  return bestOffer;
}

function notAcceptable(): Response {
  return new Response("406 Not Acceptable\n", {
    status: 406,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Vary: "Accept",
    },
  });
}

function markdownResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}

export default function middleware(request: Request): Response {
  const accept = request.headers.get("accept") ?? "";
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/llms.txt") {
    // /llms.txt only has a markdown representation.
    const chosen = negotiate(accept, [MARKDOWN]);
    if (!chosen) return notAcceptable();
    return markdownResponse(LLMS_TXT);
  }

  if (pathname === "/" || pathname === "") {
    // Default to HTML so server preference wins on `Accept: */*`.
    const chosen = negotiate(accept, [HTML, MARKDOWN]);
    if (!chosen) return notAcceptable();

    if (chosen === MARKDOWN) return markdownResponse(INDEX_MD);

    // HTML: continue to the SPA shell with `Vary: Accept` added so
    // downstream caches don't serve a markdown body to an HTML client
    // (and vice versa).
    return next({ headers: { Vary: "Accept" } });
  }

  // Should never happen given the matcher, but pass through safely.
  return next();
}
