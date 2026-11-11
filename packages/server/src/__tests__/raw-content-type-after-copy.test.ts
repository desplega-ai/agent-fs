import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../core/src/test-utils.js";
import { createUser, setDriveMember } from "../../../core/src/index.js";
import { LocalStorageAdapter } from "../../../core/src/storage/local-adapter.js";
import { createApp } from "../app.js";

// Local storage backend with an app URL configured: signed-url answers kind
// "app", so the live viewer reads bytes through /raw and types its object URL
// with the raw Content-Type. mv and cp must type the destination by its path.

let app: ReturnType<typeof createApp>;
let root: string;
let home: string;
let orgId: string;
let driveId: string;
let editorKey: string;
let viewerKey: string;
const prevHome = process.env.AGENT_FS_HOME;
const prevAppUrl = process.env.AGENT_FS_APP_URL;

const MARKUP = "<html><body>m</body></html>";

function as(key: string, path: string, opts?: RequestInit) {
  const headers = new Headers(opts?.headers);
  headers.set("Authorization", `Bearer ${key}`);
  return app.request(path, { ...opts, headers });
}

async function op(key: string, body: Record<string, unknown>) {
  const res = await as(key, `/orgs/${orgId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ driveId, ...body }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function rawType(key: string, p: string) {
  const res = await as(key, `/orgs/${orgId}/drives/${driveId}/files/${p}/raw`);
  expect(res.status).toBe(200);
  return res.headers.get("Content-Type") ?? "";
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "afs-copy-type-root-"));
  home = await mkdtemp(join(tmpdir(), "afs-copy-type-home-"));
  process.env.AGENT_FS_HOME = home;
  process.env.AGENT_FS_APP_URL = "http://127.0.0.1:5173";

  const db = createTestDb();
  app = createApp(db, new LocalStorageAdapter({ root }));

  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test" }),
  });
  const regBody = await reg.json();
  orgId = regBody.orgId;
  const me = await (await app.request("/auth/me", { headers: { Authorization: `Bearer ${regBody.apiKey}` } })).json();
  driveId = me.defaultDriveId;

  const editor = createUser(db, { email: "editor@example.test" });
  editorKey = editor.apiKey;
  setDriveMember(db, { driveId, userId: editor.user.id, role: "editor" });
  const viewer = createUser(db, { email: "viewer@example.test" });
  viewerKey = viewer.apiKey;
  setDriveMember(db, { driveId, userId: viewer.user.id, role: "viewer" });
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.AGENT_FS_HOME;
  else process.env.AGENT_FS_HOME = prevHome;
  if (prevAppUrl === undefined) delete process.env.AGENT_FS_APP_URL;
  else process.env.AGENT_FS_APP_URL = prevAppUrl;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("raw Content-Type after mv and cp on the local backend", () => {
  test("write types the object by its path and signed-url is kind app", async () => {
    await op(editorKey, { op: "write", path: "/ctl.html", content: MARKUP });
    await op(editorKey, { op: "write", path: "/ctl.pdf", content: "%PDF-1.4\n" });
    expect(await rawType(viewerKey, "ctl.html")).toContain("text/html");
    expect(await rawType(viewerKey, "ctl.pdf")).toContain("application/pdf");
    const signed = await op(viewerKey, { op: "signed-url", path: "/ctl.pdf", disposition: "inline" });
    expect(signed.kind).toBe("app");
  });

  test("mv types the destination by its path", async () => {
    await op(editorKey, { op: "write", path: "/x.html", content: MARKUP });
    await op(editorKey, { op: "mv", from: "/x.html", to: "/x.pdf" });
    const signed = await op(viewerKey, { op: "signed-url", path: "/x.pdf", disposition: "inline" });
    expect(signed.kind).toBe("app");
    expect(await rawType(viewerKey, "x.pdf")).toBe("application/pdf");
  });

  test("cp types the destination by its path", async () => {
    await op(editorKey, { op: "write", path: "/y.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    await op(editorKey, { op: "cp", from: "/y.svg", to: "/y.pdf" });
    expect(await rawType(viewerKey, "y.pdf")).toBe("application/pdf");
    // The source keeps its own type.
    expect(await rawType(viewerKey, "y.svg")).toContain("image/svg+xml");
  });
});
