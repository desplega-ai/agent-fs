/**
 * IndexNow submission script — runs as `postbuild` on Vercel.
 *
 * The IndexNow key file is intentionally committed at `public/<key>.txt`
 * (public verification token, NOT a secret).
 *
 * Reads `public/sitemap.xml` directly (this is a Vite app — no Next.js
 * `sitemap.ts` to import).
 *
 * Modes:
 *   default          submit URLs whose `<lastmod>` is within WINDOW_DAYS
 *   --backfill       submit the full URL list (bypass date filter)
 *   --dry-run        log the payload, skip the POST, bypass the VERCEL_ENV gate
 *
 * Build never fails because of IndexNow — all errors are caught and swallowed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "agent-fs.dev";
const INDEXNOW_KEY =
  "f869d842c21e99bc25e0a64c4a787efc3427328fa09d4f77827e0bfe696e9b97";
const KEY_LOCATION = `https://${HOST}/${INDEXNOW_KEY}.txt`;
const ENDPOINT = "https://api.indexnow.org/IndexNow";
const SITEMAP_PATH = join(process.cwd(), "public", "sitemap.xml");
const WINDOW_DAYS = 14;
const MAX_URLS = 10_000;

const args = new Set(process.argv.slice(2));
const isBackfill = args.has("--backfill");
const isDryRun = args.has("--dry-run");

interface SitemapEntry {
  url: string;
  lastModified: number;
}

function parseSitemap(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const urlBlocks = xml.match(/<url\b[\s\S]*?<\/url>/g) ?? [];
  for (const block of urlBlocks) {
    const locMatch = block.match(/<loc>([^<]+)<\/loc>/);
    if (!locMatch) continue;
    const url = locMatch[1].trim();
    const lastmodMatch = block.match(/<lastmod>([^<]+)<\/lastmod>/);
    const lastModified = lastmodMatch
      ? new Date(lastmodMatch[1].trim()).getTime()
      : Date.now();
    entries.push({ url, lastModified });
  }
  return entries;
}

async function main() {
  if (process.env.VERCEL_ENV !== "production" && !isBackfill && !isDryRun) {
    console.log("[indexnow] skipped, not production");
    return;
  }

  const xml = readFileSync(SITEMAP_PATH, "utf-8");
  const entries = parseSitemap(xml);
  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  let urls = entries
    .filter((e) => isBackfill || e.lastModified > cutoff)
    .map((e) => e.url);

  if (urls.length === 0) {
    console.log("[indexnow] no URLs to submit");
    return;
  }

  if (urls.length > MAX_URLS) {
    console.warn(
      `[indexnow] urlList capped from ${urls.length} → ${MAX_URLS}`,
    );
    urls = urls.slice(0, MAX_URLS);
  }

  const payload = {
    host: HOST,
    key: INDEXNOW_KEY,
    keyLocation: KEY_LOCATION,
    urlList: urls,
  };

  if (isDryRun) {
    console.log("[indexnow] dry-run payload:");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[indexnow] submitting ${urls.length} URL(s) to ${ENDPOINT}`);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  console.log(`[indexnow] response ${res.status} ${res.statusText}`);
}

main().catch((err) => {
  console.error("[indexnow] submission failed (fail-open):", err);
  process.exit(0);
});
