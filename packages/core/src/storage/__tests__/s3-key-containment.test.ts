import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { createUser } from "../../identity/users.js";
import { listUserOrgs } from "../../identity/orgs.js";
import { listDrives } from "../../identity/drives.js";
import { dispatchOp } from "../../ops/index.js";
import { ValidationError } from "../../errors.js";
import { createTestContext } from "../../test-utils.js";
import { AgentS3Client } from "../../s3/client.js";
import type { OpContext } from "../../ops/types.js";

/**
 * The S3-compatible adapter (real AgentS3Client, real AWS SDK v3 HTTP stack
 * under Bun) pointed at a loopback TCP listener that only records the raw
 * HTTP request line and answers with a dummy body. No real provider.
 *
 * A user-supplied path must never put a storage request on the wire whose
 * key, once dot segments are resolved, leaves the caller's
 * `<orgId>/drives/<driveId>/` prefix.
 */

const BUCKET = "test-bucket";

type Recorded = { method: string; target: string };

/** RFC 3986 remove_dot_segments on the decoded path, as a resolving provider would. */
function resolveDots(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== ".") out.push(seg);
  }
  return out.join("/");
}

/** Decoded object key a provider would see after resolving dot segments. */
function resolvedKey(target: string): string {
  const pathOnly = target.split("?")[0];
  const decoded = decodeURIComponent(pathOnly);
  const resolved = resolveDots(decoded);
  const prefix = `/${BUCKET}/`;
  return resolved.startsWith(prefix) ? resolved.slice(prefix.length) : resolved;
}

describe("S3 adapter keeps user paths inside the caller's drive", () => {
  let server: Server;
  let port: number;
  const recorded: Recorded[] = [];
  let caller: OpContext;
  let otherOrgId: string;
  let otherDriveId: string;

  beforeAll(async () => {
    server = createServer((sock: Socket) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        const [method, target] = buf.split("\r\n")[0].split(" ");
        recorded.push({ method, target });
        const body = "dummy-body";
        sock.end(
          "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/plain\r\n" +
            `Content-Length: ${body.length}\r\n` +
            'ETag: "e"\r\n' +
            "Connection: close\r\n\r\n" +
            (method === "HEAD" ? "" : body),
        );
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;

    const base = createTestContext();
    const s3 = new AgentS3Client({
      provider: "minio",
      bucket: BUCKET,
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${port}`,
      accessKeyId: "dummy-access-key",
      secretAccessKey: "dummy-secret-key",
    });
    caller = { ...base.ctx, s3 };

    // A second, unrelated tenant (DB only; no object needs to exist on the mock).
    const other = createUser(base.db, { email: "other@example.com" });
    const org = listUserOrgs(base.db, other.user.id)[0];
    otherOrgId = org.id;
    otherDriveId = listDrives(base.db, org.id)[0].id;
  });

  afterAll(() => {
    server.close();
  });

  const ownPrefix = () => `${caller.orgId}/drives/${caller.driveId}/`;

  test("control: an ordinary path reaches the wire inside the caller's drive", async () => {
    recorded.length = 0;
    const res = await dispatchOp(caller, "cat", { path: "/mine.txt" });
    expect((res as { content: string }).content).toBe("dummy-body");
    const gets = recorded.filter((r) => r.method === "GET");
    expect(gets.length).toBe(1);
    expect(resolvedKey(gets[0].target)).toBe(`${ownPrefix()}mine.txt`);
  });

  for (const [op, params] of [
    ["cat", (path: string) => ({ path })],
    ["write", (path: string) => ({ path, content: "x" })],
    ["rm", (path: string) => ({ path })],
  ] as const) {
    test(`${op} with '..' segments is refused before any request leaves the app`, async () => {
      recorded.length = 0;
      const climb = `/../../../${otherOrgId}/drives/${otherDriveId}/secret.txt`;
      const err = await dispatchOp(caller, op, params(climb)).then(
        () => null,
        (e: unknown) => e,
      );

      for (const r of recorded) {
        expect(resolvedKey(r.target).startsWith(ownPrefix())).toBe(true);
      }
      expect(recorded).toEqual([]);
      expect(err).toBeInstanceOf(ValidationError);
    });
  }
});
