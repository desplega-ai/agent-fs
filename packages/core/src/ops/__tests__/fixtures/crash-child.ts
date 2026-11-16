// Child process for crash-recovery.test.ts. Sets up a drive on a file-backed
// database and local storage, then runs one op whose storage call completes and
// then never returns, so the parent can SIGKILL it inside the window between the
// storage write and the database commit. The `*-tombstoned` scenarios run
// further: they stop right after the delete version row commits, before the
// comment and star cleanup.
import { writeSync } from "node:fs";
import { createDatabase } from "../../../db/index.js";
import { LocalStorageAdapter } from "../../../storage/local-adapter.js";
import { createUser } from "../../../identity/users.js";
import { listUserOrgs } from "../../../identity/orgs.js";
import { listDrives } from "../../../identity/drives.js";
import { write } from "../../write.js";
import { rm } from "../../rm.js";
import { mv } from "../../mv.js";
import { commentAdd } from "../../comment.js";
import { favoriteAdd } from "../../favorite.js";
import { subscribeDrive } from "../../../events/bus.js";
import type { OpContext } from "../../types.js";

const [dbPath, root, scenario] = process.argv.slice(2);
const db = createDatabase(dbPath);
const s3 = new LocalStorageAdapter({ root });
const { user } = createUser(db, { email: "crash@example.com" });
const orgId = listUserOrgs(db, user.id)[0].id;
const driveId = listDrives(db, orgId)[0].id;
const ctx: OpContext = { db, s3, orgId, driveId, userId: user.id };

if (scenario !== "new") await write(ctx, { path: "/f.txt", content: "old content" });
if (scenario.endsWith("-tombstoned")) {
  await commentAdd(ctx, { path: "/f.txt", body: "note" });
  await favoriteAdd(ctx, { path: "/f.txt" });
}
console.log(JSON.stringify({ orgId, driveId }));

if (scenario.endsWith("-tombstoned")) {
  subscribeDrive(driveId, (e) => {
    if (e.type !== "file.changed" || e.path !== "/f.txt" || e.operation !== "delete") return;
    writeSync(1, "STORED\n");
    // Block the thread synchronously so nothing after the tombstone runs.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  if (scenario === "rm-tombstoned") await rm(ctx, { path: "/f.txt" });
  else await mv(ctx, { from: "/f.txt", to: "/g.txt" });
}

const hang = () => {
  console.log("STORED");
  return new Promise<never>(() => {});
};
const put = s3.putObject.bind(s3);
const del = s3.deleteObject.bind(s3);
s3.putObject = async (...args) => { await put(...args); return hang(); };
s3.deleteObject = async (...args) => { await del(...args); return hang(); };

if (scenario === "rm") await rm(ctx, { path: "/f.txt" });
else await write(ctx, { path: "/f.txt", content: "new content, longer" });
