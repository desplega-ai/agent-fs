// Generates static markdown artifacts under `public/` at build time.
// These files are primarily useful for direct static access (e.g. tools
// that fetch `/llms.txt` without negotiation). The primary content
// negotiation happens in `middleware.ts`, which imports the same source.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INDEX_MD, LLMS_TXT } from "../content/markdown.js";

const landingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(landingRoot, "public");
const mdDir = path.join(publicDir, "md");

await mkdir(mdDir, { recursive: true });

const files: Array<[string, string]> = [
  [path.join(mdDir, "index.md"), INDEX_MD],
  [path.join(publicDir, "llms.txt"), LLMS_TXT],
];

for (const [file, contents] of files) {
  await writeFile(file, contents, "utf8");
  console.log(`wrote ${path.relative(landingRoot, file)} (${contents.length} bytes)`);
}
