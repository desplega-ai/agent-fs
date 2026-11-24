// The real agent-fs server for a Playwright test, run with Bun because the
// server needs `bun:sqlite` (`html-links.spec.ts` starts it).
// Reads `{ files: { [path]: content }, folders: [path] }` as JSON on stdin,
// writes the files, shares each folder as a site, serves the app on 127.0.0.1
// at a free port and prints `SITE_SERVER { port, sharePaths: { [folder]: sharePath } }`.
import { createTestContext } from "../../../packages/core/src/test-utils.js"
import { createApp } from "../../../packages/server/src/app.js"

process.env.AGENT_FS_SITE_RATE_LIMIT = "0"

const { files, folders } = JSON.parse(await Bun.stdin.text()) as { files: Record<string, string>; folders: string[] }
const { db, s3, orgId, apiKey } = createTestContext()
const app = createApp(db, s3)

async function op(body: Record<string, unknown>) {
  const res = await app.request(`/orgs/${orgId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${body.op} ${body.path}: ${res.status} ${await res.text()}`)
  return res.json()
}

for (const [path, content] of Object.entries(files)) await op({ op: "write", path, content })
const sharePaths: Record<string, string> = {}
for (const path of folders) sharePaths[path] = (await op({ op: "share-create", path, expiresIn: 3600 })).sharePath

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
console.log(`SITE_SERVER ${JSON.stringify({ port: server.port, sharePaths })}`)
