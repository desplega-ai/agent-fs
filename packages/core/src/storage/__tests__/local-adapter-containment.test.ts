import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { schema } from "../../db/index.js";
import { createUser } from "../../identity/users.js";
import { listUserOrgs } from "../../identity/orgs.js";
import { listDrives } from "../../identity/drives.js";
import { dispatchOp } from "../../ops/index.js";
import { getS3Key } from "../../ops/versioning.js";
import { createTestContext } from "../../test-utils.js";
import { AgentS3Client } from "../../s3/client.js";
import { LocalStorageAdapter } from "../local-adapter.js";
import type { OpContext } from "../../ops/types.js";

/**
 * Two unrelated users on the REAL local-filesystem adapter.
 *
 * A drive is `<orgId>/drives/<driveId>/` inside ONE storage root and the local
 * backend resolves a key against that whole root, so a `..` segment in a
 * user-supplied path used to reach another tenant's drive. Every op funnels its
 * key through the adapter, so the adapter is where this is closed.
 */

const SECRET = "VICTIM-SECRET-BYTES";

/** path -> sha256 of every file under `dir`; a change anywhere shows up as a diff. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(await readFile(p)).digest("hex");
    }
  };
  await walk(dir);
  return out;
}

describe("LocalStorageAdapter — tenant containment", () => {
  let root: string;
  let db: ReturnType<typeof createTestContext>["db"];
  let attacker: OpContext;
  let victim: OpContext;
  let victimDir: string; // <org>/drives/<drive>
  let victimKey: string; // <org>/drives/<drive>/secret.txt

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "afs-local-contain-"));
    const base = createTestContext();
    db = base.db;
    const s3 = new LocalStorageAdapter({ root });
    attacker = { ...base.ctx, s3 };

    const v = createUser(base.db, { email: "victim@example.com" });
    const org = listUserOrgs(base.db, v.user.id)[0];
    const drive = listDrives(base.db, org.id)[0];
    victim = { ...base.ctx, s3, userId: v.user.id, orgId: org.id, driveId: drive.id };

    await dispatchOp(victim, "write", { path: "/secret.txt", content: SECRET });
    await dispatchOp(attacker, "write", { path: "/mine.txt", content: "attacker file" });
    victimDir = `${victim.orgId}/drives/${victim.driveId}`;
    victimKey = `${victimDir}/secret.txt`;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ---- climb forms -------------------------------------------------------
  // Each is a way to leave `<org>/drives/<drive>/` (three segments deep) and
  // land on `target`.
  const climb = (sep: string, dots = "..") => [dots, dots, dots].join(sep);
  const forms: Array<[string, (target: string) => string]> = [
    ["absolute climb", (t) => `/${climb("/")}/${t}`],
    ["relative climb (no leading slash)", (t) => `${climb("/")}/${t}`],
    ["trailing slash on the target", (t) => `/${climb("/")}/${t}/`],
    ["single-dot segments mixed in", (t) => `/./${climb("/./")}/./${t}`],
    ["climb via a real directory name", (t) => `/x/../${climb("/")}/${t}`],
    ["doubled separators", (t) => `//${climb("//")}//${t}`],
    ["backslash separators", (t) => `/${climb("\\")}\\${t.replaceAll("/", "\\")}`],
    ["mixed separators", (t) => `/..\\../..\\${t}`],
    ["backslash after a real segment", (t) => `/x\\..\\..\\..\\..\\${t}`],
    ["dot segment as the final component", (t) => `/${climb("/")}/${t}/..`],
  ];

  // ---- ops ---------------------------------------------------------------
  // [label, op, params builder]. `p` is the hostile path. File ops aim at the
  // victim's file, directory ops at the victim's drive directory.
  // `sql` looks the bound path up in the caller's own drive rows before it
  // reaches storage, so a hostile path there is a plain NOT_FOUND and never
  // gets as far as the adapter; every other op must be refused as invalid.
  type Attack = [label: string, op: string, build: (p: string) => unknown, expected?: string];
  const fileAttacks: Attack[] = [
    ["cat", "cat", (p) => ({ path: p })],
    ["tail", "tail", (p) => ({ path: p })],
    ["stat", "stat", (p) => ({ path: p })],
    ["reveal", "reveal", (p) => ({ path: p })],
    ["signed-url", "signed-url", (p) => ({ path: p })],
    ["write", "write", (p) => ({ path: p, content: "PWNED" })],
    ["append", "append", (p) => ({ path: p, content: "PWNED" })],
    ["edit", "edit", (p) => ({ path: p, old_string: "VICTIM", new_string: "PWNED" })],
    ["rm", "rm", (p) => ({ path: p })],
    ["cp (hostile source)", "cp", (p) => ({ from: p, to: "/stolen-copy.txt" })],
    ["cp (hostile destination)", "cp", (p) => ({ from: "/mine.txt", to: p })],
    ["mv (hostile source)", "mv", (p) => ({ from: p, to: "/stolen-move.txt" })],
    ["mv (hostile destination)", "mv", (p) => ({ from: "/mine.txt", to: p })],
    [
      "sql (bound table)",
      "sql",
      (p) => ({ query: "SELECT * FROM t", tables: { t: { path: p, format: "csv" } } }),
      "NOT_FOUND",
    ],
  ];
  const dirAttacks: Attack[] = [
    ["ls", "ls", (p) => ({ path: p })],
    ["tree", "tree", (p) => ({ path: p })],
    ["glob", "glob", (p) => ({ pattern: "*", path: p })],
  ];

  const fileVersionRows = () => db.select().from(schema.fileVersions).all().length;

  // `target` is a thunk: the victim's ids only exist once `beforeAll` has run.
  const run = (
    [label, op, build, expected = "VALIDATION_ERROR"]: Attack,
    hostile: (target: string) => string,
    target: () => string,
    form: string,
  ) =>
    test(`${label} — ${form}`, async () => {
      const before = await snapshot(root);
      const rowsBefore = fileVersionRows();

      const err = await dispatchOp(attacker, op, build(hostile(target()))).then(
        () => null,
        (e: Error) => e,
      );

      expect(err).not.toBeNull();
      expect((err as unknown as { code: string }).code).toBe(expected);
      // no bytes from the other tenant in the failure either
      expect(String(err!.message)).not.toContain(SECRET);
      // the other drive (and everything else on disk) is exactly as it was
      expect(await snapshot(root)).toEqual(before);
      // and no version row was recorded for the attempt
      expect(fileVersionRows()).toBe(rowsBefore);
    });

  test("control: the victim's file is really there and readable by the victim", async () => {
    const r = (await dispatchOp(victim, "cat", { path: "/secret.txt" })) as { content: string };
    expect(r.content).toBe(SECRET);
  });

  test("control: naming the victim's key WITHOUT dot segments stays inside the attacker's drive", async () => {
    await expect(
      dispatchOp(attacker, "cat", { path: `/${victimKey}` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  for (const [formName, build] of forms) {
    describe(`hostile path: ${formName}`, () => {
      for (const attack of fileAttacks) run(attack, build, () => victimKey, formName);
      for (const attack of dirAttacks) run(attack, build, () => victimDir, formName);
    });
  }

  test("rejects a NUL byte on every path-taking op", async () => {
    const before = await snapshot(root);
    for (const [label, op, params, expected = "VALIDATION_ERROR"] of [...fileAttacks, ...dirAttacks]) {
      const err = await dispatchOp(attacker, op, params("/notes\u0000.txt")).then(
        () => null,
        (e: Error) => e,
      );
      expect(err, label).not.toBeNull();
      expect((err as unknown as { code: string }).code, label).toBe(expected);
    }
    expect(await snapshot(root)).toEqual(before);
  });

  test("percent-encoded dots are a literal file name on this backend and reach nothing", async () => {
    // The adapter never decodes, so `%2e%2e` is just a (missing) name.
    await expect(
      dispatchOp(attacker, "cat", { path: `/%2e%2e/%2e%2e/%2e%2e/${victimKey}` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ---- legitimate names --------------------------------------------------
  test("names that merely contain dots keep working through every op", async () => {
    const names = ["/.env", "/a.b", "/..foo", "/file..", "/a..b/x...txt", "/.hidden/notes..md", "/dir../x.txt"];
    for (const path of names) {
      await dispatchOp(attacker, "write", { path, content: "ok" });
      const cat = (await dispatchOp(attacker, "cat", { path })) as { content: string };
      expect(cat.content, path).toBe("ok");
      await dispatchOp(attacker, "append", { path, content: "+more" });
      await dispatchOp(attacker, "edit", { path, old_string: "ok", new_string: "OK" });
      const st = (await dispatchOp(attacker, "stat", { path })) as { path: string };
      expect(st.path).toBe(path);

      const copy = `${path}.copy`;
      await dispatchOp(attacker, "cp", { from: path, to: copy });
      const moved = `${path}.moved`;
      await dispatchOp(attacker, "mv", { from: copy, to: moved });
      const cat2 = (await dispatchOp(attacker, "cat", { path: moved })) as { content: string };
      expect(cat2.content, path).toBe("OK+more");

      await dispatchOp(attacker, "rm", { path: moved });
      await dispatchOp(attacker, "rm", { path });
    }

    // directories with dotted names list and traverse too
    await dispatchOp(attacker, "write", { path: "/..d/.e/f.txt", content: "deep" });
    const ls = (await dispatchOp(attacker, "ls", { path: "/..d/.e" })) as { entries: Array<{ name: string }> };
    expect(ls.entries.map((e) => e.name)).toContain("f.txt");
    const gl = (await dispatchOp(attacker, "glob", { pattern: "**/f.txt", path: "/..d" })) as {
      matches: Array<{ path: string }>;
    };
    expect(gl.matches.map((m) => m.path)).toContain("/..d/.e/f.txt");
    await dispatchOp(attacker, "rm", { path: "/..d/.e/f.txt" });
  });

  test("the victim is unaffected and still reads their own file after every attempt above", async () => {
    const r = (await dispatchOp(victim, "cat", { path: "/secret.txt" })) as { content: string };
    expect(r.content).toBe(SECRET);
    expect((await fsStat(join(root, victimKey))).isFile()).toBe(true);
  });

  // ---- the adapter boundary itself --------------------------------------
  describe("adapter methods", () => {
    const own = () => `${attacker.orgId}/drives/${attacker.driveId}`;
    const hostileKey = () => `${own()}/../../../${victimKey}`;

    test("every method rejects a hostile key before touching storage", async () => {
      const s3 = attacker.s3;
      const k = hostileKey();
      const before = await snapshot(root);
      for (const [name, call] of [
        ["putObject", () => s3.putObject(k, "PWNED")],
        ["getObject", () => s3.getObject(k)],
        ["headObject", () => s3.headObject(k)],
        ["deleteObject", () => s3.deleteObject(k)],
        ["copyObject (source)", () => s3.copyObject(k, `${own()}/copy.txt`)],
        ["copyObject (destination)", () => s3.copyObject(`${own()}/mine.txt`, k)],
        ["listObjects", () => s3.listObjects(`${own()}/../../../${victimDir}/`)],
      ] as Array<[string, () => Promise<unknown>]>) {
        await expect(call(), name).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
      expect(await snapshot(root)).toEqual(before);
    });

    test("a copy with a hostile destination does not read the source first", async () => {
      let reads = 0;
      const real = attacker.s3 as LocalStorageAdapter;
      const original = real.getObject.bind(real);
      (real as { getObject: typeof real.getObject }).getObject = (...a) => {
        reads++;
        return original(...a);
      };
      try {
        await expect(
          real.copyObject(`${own()}/mine.txt`, hostileKey()),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        (real as { getObject: typeof real.getObject }).getObject = original;
      }
      expect(reads).toBe(0);
    });

    test("a version handle cannot be used to climb", async () => {
      await expect(
        attacker.s3.getObject(`${own()}/mine.txt`, `../../${victimKey}`),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        attacker.s3.getObject(`${own()}/mine.txt`, "..\\..\\x"),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("legitimate version handles and dotted keys pass through", async () => {
      const put = await attacker.s3.putObject(`${own()}/..v/.n..txt`, "v1");
      const got = await attacker.s3.getObject(`${own()}/..v/.n..txt`, put.versionId);
      expect(new TextDecoder().decode(got.body)).toBe("v1");
      await attacker.s3.deleteObject(`${own()}/..v/.n..txt`);
    });

    test("the empty prefix (health checks) and a bare drive prefix still list", async () => {
      await expect(attacker.s3.listObjects("", { delimiter: "/" })).resolves.toBeDefined();
      const { objects } = await attacker.s3.listObjects(`${own()}/`);
      expect(objects.map((o) => o.key)).toContain(getS3Key(attacker.orgId, attacker.driveId, "/mine.txt"));
    });
  });
});

describe("S3 adapter is unchanged", () => {
  // On S3 an `a/../b` key is ordinary data, so the key must reach the wire verbatim.
  function stubbedClient() {
    const client = new AgentS3Client({
      provider: "minio",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    });
    const sent: unknown[] = [];
    const stub = {
      send(command: unknown) {
        sent.push(command);
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [], CommonPrefixes: [], IsTruncated: false });
        }
        if (command instanceof GetObjectCommand) {
          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1])) },
          });
        }
        return Promise.resolve({ ETag: '"e"' });
      },
    };
    (client as unknown as { client: typeof stub }).client = stub;
    return { client, sent };
  }

  test("dot segments and backslashes are passed to S3 untouched, through ops and directly", async () => {
    const { client, sent } = stubbedClient();
    const base = createTestContext();
    const ctx: OpContext = { ...base.ctx, s3: client };

    await dispatchOp(ctx, "write", { path: "/a/../b.txt", content: "x" });
    const put = sent.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.Key).toBe(`${ctx.orgId}/drives/${ctx.driveId}/a/../b.txt`);

    await expect(client.putObject("o/drives/d/a\\..\\b", "x")).resolves.toBeDefined();
    await expect(client.putObject("o/drives/d/nul\u0000name", "x")).resolves.toBeDefined();
    await expect(client.getObject("o/drives/d/../x")).resolves.toBeDefined();
    await expect(client.listObjects("o/drives/d/../")).resolves.toBeDefined();

    const keys = sent
      .filter((c): c is PutObjectCommand | GetObjectCommand => c instanceof PutObjectCommand || c instanceof GetObjectCommand)
      .map((c) => c.input.Key);
    expect(keys).toContain("o/drives/d/a\\..\\b");
    expect(keys).toContain("o/drives/d/../x");
  });
});
